// ─── @mirk/store/sqlite ─────────────────────────────────────────────────────
// better-sqlite3 source adapter wrapper. The capability implementation lives
// in sqlite-core.ts so the node:sqlite entry never loads this native peer.

import BetterSqliteDatabase from "better-sqlite3";

import {
  BetterSqliteDriver,
} from "./sqlite-driver.js";
import {
  SqliteAdapterCore,
  type SqliteAdapterCoreOptions,
  type SqliteTransactionMode,
  type SqliteStoreInspection,
  type SqliteInspectionOptions,
  type SqliteCheckpointMode,
  type SqliteCheckpointResult,
  type SqliteAdapterErrorCode,
  SqliteAdapterError,
  validateSqliteBusyTimeout,
} from "./sqlite-core.js";

export {
  SqliteAdapterError,
  type SqliteAdapterErrorCode,
  type SqliteTransactionMode,
  type SqliteStoreInspection,
  type SqliteInspectionOptions,
  type SqliteCheckpointMode,
  type SqliteCheckpointResult,
};

export interface SqliteAdapterOptions
  extends Omit<SqliteAdapterCoreOptions, "db" | "ownsDb"> {
  /** Existing better-sqlite3 instance to reuse (shares one connection). */
  db?: BetterSqliteDatabase.Database;
}

/** Multi-capability SQLite source adapter backed by better-sqlite3. */
export class SqliteAdapter extends SqliteAdapterCore {
  constructor(opts: SqliteAdapterOptions) {
    validateSqliteBusyTimeout(opts.busyTimeoutMs);
    const ownsDb = opts.db === undefined;
    const db = opts.db ?? new BetterSqliteDatabase(opts.path, {
      timeout: opts.busyTimeoutMs ?? 30_000,
    });
    const core: SqliteAdapterCoreOptions = {
      ...opts,
      db: new BetterSqliteDriver(db),
      ownsDb,
    };
    super(core);
  }
}
