// ─── @mirk/store/transaction ────────────────────────────────────────────────
// The shared implementation of the AsyncStoreTransactions contract. An adapter
// supplies the backend primitives (begin, commit, rollback, savepoints) over its
// own connection; this coordinator owns nesting, scoping across awaits, and
// after-commit delivery so every adapter behaves the same way.

import { AsyncLocalStorage } from "node:async_hooks";

import type {
  AfterCommitNotify,
  AsyncStoreTransactions,
} from "./transaction-types.js";

export type { AfterCommitNotify, AsyncStoreTransactions };

/** The connection-level primitives an adapter supplies. `C` is whatever the
 *  adapter needs to address the open transaction, such as a pooled client. */
export interface AsyncTransactionBackend<C> {
  /** Acquire a connection, begin the outermost transaction, and take any lock
   *  that serializes it against other connections. */
  begin(): Promise<C> | C;
  /** Commit the outermost transaction. Throw if it did not commit. */
  commit(connection: C): Promise<void> | void;
  /** Roll back the outermost transaction. */
  rollback(connection: C): Promise<void> | void;
  savepoint(connection: C, name: string): Promise<void> | void;
  releaseSavepoint(connection: C, name: string): Promise<void> | void;
  rollbackToSavepoint(connection: C, name: string): Promise<void> | void;
  /** Called exactly once after the outermost transaction ends, before any
   *  after-commit callback. `cleanupError` is set when rollback itself failed,
   *  which usually means the connection is unusable. */
  end(connection: C, cleanupError?: unknown): Promise<void> | void;
}

/** Thrown when a transaction scope is used out of order. */
export class TransactionScopeError extends Error {
  declare readonly name: "TransactionScopeError";
  constructor(
    readonly code: "transaction-ended" | "nested-transaction-active",
    message: string
  ) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
Object.defineProperty(TransactionScopeError.prototype, "name", {
  value: "TransactionScopeError",
  writable: true,
  configurable: true,
  enumerable: false,
});

interface Scope<C> {
  readonly connection: C;
  readonly parent: Scope<C> | undefined;
  readonly callbacks: { notify: AfterCommitNotify; scope: Scope<C> }[];
  active: boolean;
  childActive: boolean;
  rolledBack: boolean;
  /** Serializes sibling nested transactions on this scope. */
  tail: Promise<unknown>;
}

function ended(): TransactionScopeError {
  return new TransactionScopeError(
    "transaction-ended",
    "The transaction has ended; await every store call inside transaction()."
  );
}

function childActive(): TransactionScopeError {
  return new TransactionScopeError(
    "nested-transaction-active",
    "Await the nested transaction before using its parent transaction."
  );
}

/**
 * Implements {@link AsyncStoreTransactions} over an adapter's backend.
 *
 * Store operations ask {@link current} for the connection of the transaction
 * that the calling async context is inside, and use their own connection when
 * there is none.
 */
export class AsyncTransactionCoordinator<C> implements AsyncStoreTransactions {
  readonly #scopes = new AsyncLocalStorage<Scope<C>>();
  #savepoints = 0;

  constructor(private readonly backend: AsyncTransactionBackend<C>) {}

  /** The open transaction's connection for the calling async context, or
   *  `undefined` outside a transaction. Throws if that transaction has ended
   *  or a nested transaction is still running in it. */
  current(): C | undefined {
    const scope = this.#scopes.getStore();
    if (!scope) return undefined;
    if (!scope.active) throw ended();
    if (scope.childActive) throw childActive();
    return scope.connection;
  }

  /** True when the calling async context is inside an open transaction that
   *  may issue statements now. */
  inUsableScope(): boolean {
    const scope = this.#scopes.getStore();
    return scope !== undefined && scope.active && !scope.childActive;
  }

  transaction<T>(work: () => T | Promise<T>): Promise<T> {
    const parent = this.#scopes.getStore();
    return parent ? this.#nested(parent, work) : this.#outermost(work);
  }

  afterCommit(notify: AfterCommitNotify): void {
    const scope = this.#scopes.getStore();
    if (!scope) {
      deliver([notify]);
      return;
    }
    if (!scope.active) throw ended();
    scope.callbacks.push({ notify, scope });
  }

  async #outermost<T>(work: () => T | Promise<T>): Promise<T> {
    const connection = await this.backend.begin();
    const scope: Scope<C> = {
      connection,
      parent: undefined,
      callbacks: [],
      active: true,
      childActive: false,
      rolledBack: false,
      tail: Promise.resolve(),
    };
    let value: T;
    try {
      value = await this.#scopes.run(scope, async () => {
        const result = await work();
        await scope.tail;
        return result;
      });
      await this.backend.commit(connection);
    } catch (error) {
      scope.active = false;
      // A nested transaction the work did not await may still be issuing
      // statements; let it finish before the connection is rolled back.
      await scope.tail;
      let cleanupError: unknown;
      try {
        await this.backend.rollback(connection);
      } catch (rollbackError) {
        cleanupError = rollbackError;
      }
      await this.backend.end(connection, cleanupError);
      throw error;
    }
    scope.active = false;
    await this.backend.end(connection);
    deliver(
      scope.callbacks
        .filter((entry) => !rolledBackChain(entry.scope))
        .map((entry) => entry.notify)
    );
    return value;
  }

  #nested<T>(parent: Scope<C>, work: () => T | Promise<T>): Promise<T> {
    const run = parent.tail.then(async () => {
      if (!parent.active) throw ended();
      const name = `mirk_tx_${++this.#savepoints}`;
      const child: Scope<C> = {
        connection: parent.connection,
        parent,
        callbacks: parent.callbacks,
        active: true,
        childActive: false,
        rolledBack: false,
        tail: Promise.resolve(),
      };
      parent.childActive = true;
      let created = false;
      try {
        await this.backend.savepoint(parent.connection, name);
        created = true;
        const value = await this.#scopes.run(child, async () => {
          const result = await work();
          await child.tail;
          return result;
        });
        await this.backend.releaseSavepoint(parent.connection, name);
        return value;
      } catch (error) {
        child.rolledBack = true;
        if (created) {
          await this.backend.rollbackToSavepoint(parent.connection, name);
          await this.backend.releaseSavepoint(parent.connection, name);
        }
        throw error;
      } finally {
        child.active = false;
        parent.childActive = false;
      }
    });
    parent.tail = run.catch(() => undefined);
    return run;
  }
}

function rolledBackChain<C>(scope: Scope<C> | undefined): boolean {
  for (let current = scope; current; current = current.parent) {
    if (current.rolledBack) return true;
  }
  return false;
}

function deliver(callbacks: readonly AfterCommitNotify[]): void {
  for (const notify of callbacks) {
    try {
      const result: unknown = notify();
      if (
        result !== null &&
        typeof result === "object" &&
        typeof (result as { then?: unknown }).then === "function"
      ) {
        (result as PromiseLike<unknown>).then(undefined, () => undefined);
      }
    } catch {
      // One listener's failure must not stop the others or undo the commit.
    }
  }
}
