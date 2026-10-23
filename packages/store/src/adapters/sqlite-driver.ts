/**
 * The small synchronous SQLite surface used by the store core.
 *
 * Both better-sqlite3 and node:sqlite expose the same SQLite primitives, but
 * their connection objects differ around pragmas, transaction helpers, and
 * transaction-state inspection. Keeping those differences here lets the
 * adapter facets remain one implementation and keeps the built-in adapter
 * free of a better-sqlite3 import.
 */

export interface SqliteStatement {
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
}

export interface SqliteTransaction<T, A = void> {
  (arg: A): T;
  deferred(arg: A): T;
  immediate(arg: A): T;
  exclusive(arg: A): T;
}

export interface SqliteDb {
  prepare(sql: string): SqliteStatement;
  exec(sql: string): void;
  pragma(sql: string): unknown;
  transaction<T>(work: () => T): SqliteTransaction<T>;
  transaction<T, A>(work: (arg: A) => T): SqliteTransaction<T, A>;
  readonly inTransaction: boolean;
  close(): void;
}

export interface BetterSqliteConnection {
  prepare(sql: string): SqliteStatement;
  exec(sql: string): void;
  pragma(sql: string, options?: { simple?: boolean }): unknown;
  transaction(work: (...args: unknown[]) => unknown): {
    (...args: unknown[]): unknown;
    deferred(...args: unknown[]): unknown;
    immediate(...args: unknown[]): unknown;
    exclusive(...args: unknown[]): unknown;
  };
  readonly inTransaction: boolean;
  close(): void;
};

/** Adapter around an existing better-sqlite3 Database instance. */
export class BetterSqliteDriver implements SqliteDb {
  constructor(readonly raw: BetterSqliteConnection) {}

  prepare(sql: string): SqliteStatement {
    return this.raw.prepare(sql);
  }

  exec(sql: string): void {
    this.raw.exec(sql);
  }

  pragma(sql: string): unknown {
    return this.raw.pragma(sql);
  }

  transaction<T>(work: (...args: unknown[]) => T): SqliteTransaction<T, any> {
    return this.raw.transaction(work) as SqliteTransaction<T, any>;
  }

  get inTransaction(): boolean {
    return this.raw.inTransaction;
  }

  close(): void {
    this.raw.close();
  }
}

export interface NodeSqliteConnection {
  prepare(sql: string): SqliteStatement;
  exec(sql: string): void;
  readonly isTransaction: boolean;
  close(): void;
}

/**
 * Adapter around node:sqlite's DatabaseSync. Node's API intentionally does
 * not provide better-sqlite3's transaction function, so this wrapper uses
 * BEGIN/COMMIT and SAVEPOINT for the same nested-transaction semantics.
 */
export class NodeSqliteDriver implements SqliteDb {
  private savepointId = 0;

  constructor(readonly raw: NodeSqliteConnection) {}

  prepare(sql: string): SqliteStatement {
    return this.raw.prepare(sql);
  }

  exec(sql: string): void {
    this.raw.exec(sql);
  }

  pragma(sql: string): unknown {
    const rows = this.raw.prepare(`PRAGMA ${sql}`).all();
    return rows;
  }

  transaction<T>(work: () => T): SqliteTransaction<T>;
  transaction<T, A>(work: (arg: A) => T): SqliteTransaction<T, A>;
  transaction<T, A>(work: (arg: A) => T): SqliteTransaction<T, A> {
    const invoke = (mode: "deferred" | "immediate" | "exclusive", arg: A): T => {
      const nested = this.inTransaction;
      const savepoint = `mirk_tx_${++this.savepointId}`;
      if (nested) this.raw.exec(`SAVEPOINT ${savepoint}`);
      else this.raw.exec(`BEGIN ${mode.toUpperCase()}`);
      try {
        const value = work(arg);
        if (value && typeof (value as { then?: unknown }).then === "function") {
          throw new TypeError("Transaction function cannot return a promise");
        }
        if (nested) this.raw.exec(`RELEASE SAVEPOINT ${savepoint}`);
        else this.raw.exec("COMMIT");
        return value;
      } catch (error) {
        try {
          if (nested) {
            this.raw.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
            this.raw.exec(`RELEASE SAVEPOINT ${savepoint}`);
          } else {
            this.raw.exec("ROLLBACK");
          }
        } catch {
          // Preserve the operation's original failure when rollback itself
          // fails (for example, after an externally closed connection).
        }
        throw error;
      }
    };
    const tx = ((arg: A) => invoke("deferred", arg)) as SqliteTransaction<T, A>;
    tx.deferred = (arg: A) => invoke("deferred", arg);
    tx.immediate = (arg: A) => invoke("immediate", arg);
    tx.exclusive = (arg: A) => invoke("exclusive", arg);
    return tx;
  }

  get inTransaction(): boolean {
    return this.raw.isTransaction;
  }

  close(): void {
    this.raw.close();
  }
}
