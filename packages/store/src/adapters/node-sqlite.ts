// ─── @mirk/store/node-sqlite ───────────────────────────────────────────────
// The built-in Node/Electron SQLite source adapter. It shares every store
// facet and schema with @mirk/store/sqlite, but opens node:sqlite's synchronous
// DatabaseSync instead of loading a better-sqlite3 native binding.

import { createRequire } from "node:module";

import {
  NodeSqliteDriver,
  type NodeSqliteConnection,
} from "./sqlite-driver.js";
import {
  SqliteAdapterCore,
  type SqliteAdapterCoreOptions,
  validateSqliteBusyTimeout,
} from "./sqlite-core.js";

// Keep the `node:` scheme in the published ESM. tsup/esbuild strips the
// prefix from a static built-in import, which would turn this one into the
// non-existent package `sqlite`; createRequire preserves the Node/Electron
// builtin resolution while retaining the type from node:sqlite.
const sqlite = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
const { DatabaseSync } = sqlite;

export {
  SqliteAdapterError,
  type SqliteAdapterErrorCode,
  type SqliteTransactionMode,
  type SqliteStoreInspection,
  type SqliteInspectionOptions,
  type SqliteCheckpointMode,
  type SqliteCheckpointResult,
} from "./sqlite-core.js";

export interface NodeSqliteAdapterOptions
  extends Omit<SqliteAdapterCoreOptions, "db" | "ownsDb"> {
  /** Existing node:sqlite DatabaseSync instance to reuse. */
  db?: NodeSqliteConnection;
}

/** Multi-capability adapter over Node's built-in synchronous SQLite driver. */
export class NodeSqliteAdapter extends SqliteAdapterCore {
  constructor(opts: NodeSqliteAdapterOptions) {
    validateSqliteBusyTimeout(opts.busyTimeoutMs);
    const ownsDb = opts.db === undefined;
    const db = opts.db ?? new DatabaseSync(opts.path, {
      timeout: opts.busyTimeoutMs ?? 30_000,
    });
    const driver = new NodeSqliteDriver(db);
    const core: SqliteAdapterCoreOptions = {
      ...opts,
      db: driver,
      ownsDb,
    };
    super(core);
  }
}
