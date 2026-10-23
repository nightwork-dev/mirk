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
    readonly code: "transaction-ended",
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
  /** Outermost scope only: a nested rollback failed, so the transaction
   *  holds writes it could not undo and must not commit. */
  unsafe?: { error: unknown };
}

function ended(): TransactionScopeError {
  return new TransactionScopeError(
    "transaction-ended",
    "The transaction has ended; await every store call inside transaction()."
  );
}

/**
 * Implements {@link AsyncStoreTransactions} over an adapter's backend.
 *
 * Store operations run through {@link withConnection}, which hands them the
 * connection of the transaction the calling async context is inside, or
 * `undefined` so they use their own connection.
 */
export class AsyncTransactionCoordinator<C> implements AsyncStoreTransactions {
  readonly #scopes = new AsyncLocalStorage<Scope<C>>();
  #savepoints = 0;

  constructor(private readonly backend: AsyncTransactionBackend<C>) {}

  /** Run `op` with the open transaction's connection for the calling async
   *  context, or with `undefined` outside a transaction. While a nested
   *  transaction of that scope is running, `op` waits for it to finish, so the
   *  statement never lands inside a savepoint that may roll back. `op` is
   *  invoked synchronously after the final check. Throws
   *  `TransactionScopeError` if the transaction has ended. */
  async withConnection<T>(
    op: (connection: C | undefined) => T | Promise<T>
  ): Promise<T> {
    const scope = this.#scopes.getStore();
    if (!scope) return op(undefined);
    for (;;) {
      if (!scope.active) throw ended();
      if (!scope.childActive) return op(scope.connection);
      await scope.tail;
    }
  }

  /** True when the calling async context is inside an open transaction. */
  inTransaction(): boolean {
    return this.#scopes.getStore()?.active === true;
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
      value = await this.#scopes.run(scope, work);
      // COMMIT is queued in the same tick as the last check of the tail, so
      // a call that arrives later is refused rather than run outside.
      await settle(scope, () => {
        scope.active = false;
        if (scope.unsafe) throw scope.unsafe.error;
        return this.backend.commit(connection);
      });
    } catch (error) {
      scope.active = false;
      // A nested transaction the work did not await may still be issuing
      // statements; let it finish before the connection is rolled back.
      await settle(scope, () => undefined);
      let cleanupError: unknown;
      try {
        await this.backend.rollback(connection);
      } catch (rollbackError) {
        cleanupError = rollbackError;
      }
      await this.backend.end(connection, cleanupError);
      throw error;
    }
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
        const value = await this.#scopes.run(child, work);
        await settle(child, () => {
          child.active = false;
          return this.backend.releaseSavepoint(parent.connection, name);
        });
        return value;
      } catch (error) {
        child.active = false;
        await settle(child, () => undefined);
        child.rolledBack = true;
        if (created) {
          try {
            await this.backend.rollbackToSavepoint(parent.connection, name);
            await this.backend.releaseSavepoint(parent.connection, name);
          } catch (rollbackError) {
            // The savepoint's writes may still be in the transaction. Report
            // the work's own error, and make the outermost transaction roll
            // back instead of committing them.
            outermostOf(parent).unsafe ??= { error: rollbackError };
            attachRollbackError(error, rollbackError);
          }
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

/** Wait until no nested transaction is queued on `scope`, including ones
 *  queued while waiting, then call `next` in the same tick as the final check. */
async function settle<C, R>(scope: Scope<C>, next: () => R | Promise<R>): Promise<R> {
  for (;;) {
    const tail = scope.tail;
    await tail;
    if (tail === scope.tail) return next();
  }
}

function outermostOf<C>(scope: Scope<C>): Scope<C> {
  let current = scope;
  while (current.parent) current = current.parent;
  return current;
}

/** Attach a failed rollback to the error that caused it, as `rollbackError`. */
function attachRollbackError(error: unknown, rollbackError: unknown): void {
  if (error === null || (typeof error !== "object" && typeof error !== "function")) return;
  if (!Object.isExtensible(error) || Object.hasOwn(error, "rollbackError")) return;
  Object.defineProperty(error, "rollbackError", {
    value: rollbackError,
    enumerable: true,
    configurable: true,
    writable: true,
  });
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
      Promise.resolve(notify() as unknown).catch(() => undefined);
    } catch {
      // One listener's failure must not stop the others or undo the commit.
    }
  }
}
