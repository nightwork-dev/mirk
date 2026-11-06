import type { SqliteMigrationResult } from "../sql.js";
import { ensureMirkFormat } from "./sqlite-format.js";
import { sqliteSnapshot, sqliteFileSnapshot } from "./sqlite-backup.js";
// ─── @mirk/store/node-sqlite ───────────────────────────────────────────────
// The built-in Node SQLite source adapter. It shares every store
// facet and schema with @mirk/store/sqlite, but opens node:sqlite's synchronous
// DatabaseSync instead of loading a better-sqlite3 native binding.

import { createRequire } from "node:module";

import {
  NodeSqliteDriver,
  type NodeSqliteConnection,
} from "./sqlite-driver.js";
import {
  SqliteAdapterCore,
  SqliteAdapterError,
  type SqliteAdapterCoreOptions,
  validateSqliteBusyTimeout,
} from "./sqlite-core.js";

// Keep the `node:` scheme in the published ESM. tsup/esbuild strips the
// prefix from a static built-in import, which would turn this one into the
// non-existent package `sqlite`; createRequire preserves the Node
// builtin resolution while retaining the type from node:sqlite.
const sqlite = createRequire(import.meta.url)(
  "node:sqlite",
) as typeof import("node:sqlite");
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
  extends Omit<SqliteAdapterCoreOptions, "db" | "ownsDb" | "migrationBackup"> {
  /** Existing node:sqlite DatabaseSync instance to reuse. */
  db?: NodeSqliteConnection;
}

/** Multi-capability adapter over Node's built-in synchronous SQLite driver. */
export class NodeSqliteAdapter extends SqliteAdapterCore {
  static migrate(opts: NodeSqliteAdapterOptions): SqliteMigrationResult {
    validateSqliteBusyTimeout(opts.busyTimeoutMs);
    const db = opts.db ?? new DatabaseSync(opts.path);
    const driver = new NodeSqliteDriver(db);
    try {
      driver.pragma(`busy_timeout = ${opts.busyTimeoutMs ?? 30000}`);
      return ensureMirkFormat(
        driver,
        (code, message) => new SqliteAdapterError(code, message),
        { ...opts, migration: "auto" },
        (path) =>
          sqliteSnapshot(
            driver,
            path,
            (source) => new DatabaseSync(source, { readOnly: true }),
          ),
      );
    } finally {
      if (!opts.db) db.close();
    }
  }
  constructor(opts: NodeSqliteAdapterOptions) {
    validateSqliteBusyTimeout(opts.busyTimeoutMs);
    const ownsDb = opts.db === undefined;
    const db =
      opts.db ??
      new DatabaseSync(opts.path, {
        timeout: opts.busyTimeoutMs ?? 30_000,
        allowExtension: opts.vectorEngine !== undefined,
      });
    const driver = new NodeSqliteDriver(db);
    const migrationBackup = (path: string) =>
      sqliteSnapshot(
        new NodeSqliteDriver(db),
        path,
        (source) => new DatabaseSync(source, { readOnly: true }),
      );
    const core: SqliteAdapterCoreOptions = {
      ...opts,
      db: driver,
      ownsDb,
      migrationBackup,
    };
    super(core);
  }
}

export function backupSqliteFile(source: string, destination: string): void {
  sqliteFileSnapshot(
    source,
    destination,
    (path) => new DatabaseSync(path, { readOnly: true }),
  );
}
