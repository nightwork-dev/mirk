import type { InStatement, ResultSet } from "@libsql/client";
import type {
  StoreTarget,
  StoreVersion,
  VersionedStoreValue,
} from "@mirk/store";
import { LibsqlReceiptStorage } from "./libsql-receipts.js";
import { guard } from "./libsql-errors.js";

export abstract class LibsqlVersionStorage extends LibsqlReceiptStorage {
  protected versionPrefix = "";
  protected abstract ensureTable(collection: string): Promise<string>;
  /** Runs inside the adapter's opening transaction. */
  async init(versionIdentity: string): Promise<void> {
    const n = this.names;
    await this.db.execute(`
      CREATE TABLE IF NOT EXISTS ${n.kv} (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      )
    `);
    // The same tables, in the same shape, as @mirk/store/sqlite's atomic store.
    await this.db.execute(`
      CREATE TABLE IF NOT EXISTS ${n.versions} (
        kind TEXT NOT NULL,
        collection TEXT NOT NULL,
        target_key TEXT NOT NULL,
        version TEXT NOT NULL,
        PRIMARY KEY (kind, collection, target_key)
      )
    `);
    await this.db.execute(`
      CREATE TABLE IF NOT EXISTS ${n.sequence} (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        value INTEGER NOT NULL
      )
    `);
    await this.db.execute(
      `INSERT OR IGNORE INTO ${n.sequence} (id, value) VALUES (1, 0)`,
    );
    await this.db.execute(`
      CREATE TABLE IF NOT EXISTS ${n.receipts} (
        idempotency_key TEXT PRIMARY KEY,
        request_digest TEXT NOT NULL,
        result_json TEXT NOT NULL,
        created_at INTEGER
      )
    `);
    // Receipts written by @mirk/store/sqlite or an earlier release carry no
    // creation time.
    const receiptColumns = await this.db.execute(
      `PRAGMA table_info(${n.receipts})`,
    );
    if (!receiptColumns.rows.some((row) => row.name === "created_at")) {
      await this.db.execute(
        `ALTER TABLE ${n.receipts} ADD COLUMN created_at INTEGER`,
      );
    }
    await this.db.execute(
      `CREATE INDEX IF NOT EXISTS ${n.receipts}_created_at ON ${n.receipts} (created_at)`,
    );
    await this.db.execute(`
      CREATE TABLE IF NOT EXISTS ${n.identity} (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        value TEXT NOT NULL
      )
    `);
    await this.db.execute({
      sql: `INSERT OR IGNORE INTO ${n.identity} (id, value) VALUES (1, ?)`,
      args: [versionIdentity],
    });
    const identity = await this.db.execute(
      `SELECT value FROM ${n.identity} WHERE id = 1`,
    );
    this.versionPrefix = identity.rows[0]!.value as string;
  }

  async getVersioned<T>(
    target: StoreTarget,
  ): Promise<VersionedStoreValue<T> | null> {
    const row = await this.readVersioned(target);
    if (!row) return null;
    // A row written before this adapter issued version tokens gets one now,
    // with the value read in the same transaction: another host may have
    // written the row since the read above.
    const versioned =
      row.version === null
        ? await this.write(() => this.backfillVersion(target))
        : row;
    return versioned === null
      ? null
      : {
          value: JSON.parse(versioned.value) as T,
          version: versioned.version!,
        };
  }

  protected async readVersioned(
    target: StoreTarget,
  ): Promise<{ value: string; version: StoreVersion | null } | null> {
    const table =
      target.kind === "record" ? await this.ensureTable(target.collection) : "";
    return versionedRow(
      await this.db.execute(this.readVersionedStatement(target, table)),
    );
  }

  /** Selects `target`'s value and version token; `table` is its collection's
   *  table. See `versionedRow`. */
  protected readVersionedStatement(
    target: StoreTarget,
    table: string,
  ): InStatement {
    const n = this.names;
    if (target.kind === "key") {
      return {
        sql: `SELECT k.value AS value, v.version AS version
              FROM ${n.kv} AS k
              LEFT JOIN ${n.versions} AS v
                ON v.kind = 'key' AND v.collection = '' AND v.target_key = k.key
              WHERE k.key = ?`,
        args: [target.key],
      };
    }
    return {
      sql: `SELECT c.data AS value, v.version AS version
            FROM ${table} AS c
            LEFT JOIN ${n.versions} AS v
              ON v.kind = 'record' AND v.collection = ? AND v.target_key = c.id
            WHERE c.id = ?`,
      args: [target.collection, target.id],
    };
  }

  /** Issue the next version token for `target` in the open transaction. The
   *  statements in `with` run first, in the same round trip. */
  protected mint(
    target: StoreTarget,
    before: InStatement[],
  ): Promise<StoreVersion> {
    const n = this.names;
    return this.db.inTransaction(async (open) => {
      const results = await guard(
        open.batch([
          ...before,
          `UPDATE ${n.sequence} SET value = value + 1 WHERE id = 1 RETURNING value`,
          {
            sql: `INSERT INTO ${n.versions} (kind, collection, target_key, version)
                SELECT ?, ?, ?, ? || '-v' || value FROM ${n.sequence} WHERE id = 1
                ON CONFLICT(kind, collection, target_key) DO UPDATE SET version = excluded.version`,
            args: [...versionKey(target), this.versionPrefix],
          },
        ]),
      );
      const minted = Number(results[before.length]!.rows[0]!.value);
      open.minted = Math.max(open.minted, minted);
      return `${this.versionPrefix}-v${minted}` as StoreVersion;
    });
  }

  protected clearVersion(target: StoreTarget): InStatement {
    return {
      sql: `DELETE FROM ${this.names.versions} WHERE kind = ? AND collection = ? AND target_key = ?`,
      args: versionKey(target),
    };
  }

  protected upsertKeyStatement(key: string, encoded: string): InStatement {
    return {
      sql: `INSERT INTO ${this.names.kv} (key, value, updated_at) VALUES (?, ?, datetime('now'))
            ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
      args: [key, encoded],
    };
  }

  protected upsertRecordStatement(
    table: string,
    id: string,
    encoded: string,
  ): InStatement {
    return {
      sql: `INSERT INTO ${table} (id, data, updated_at) VALUES (?, ?, datetime('now'))
            ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = datetime('now')`,
      args: [id, encoded],
    };
  }

  protected writeKey(key: string, encoded: string): Promise<StoreVersion> {
    return this.mint({ kind: "key", key }, [
      this.upsertKeyStatement(key, encoded),
    ]);
  }

  protected async writeRecord(
    collection: string,
    id: string,
    encoded: string,
  ): Promise<StoreVersion> {
    const table = await this.ensureTable(collection);
    return this.mint({ kind: "record", collection, id }, [
      this.upsertRecordStatement(table, id, encoded),
    ]);
  }

  protected async deleteKey(key: string): Promise<boolean> {
    const [deleted] = await this.db.inTransaction((open) =>
      guard(
        open.batch([
          { sql: `DELETE FROM ${this.names.kv} WHERE key = ?`, args: [key] },
          this.clearVersion({ kind: "key", key }),
        ]),
      ),
    );
    return deleted!.rowsAffected > 0;
  }

  protected async deleteRecord(
    collection: string,
    id: string,
  ): Promise<boolean> {
    const table = await this.ensureTable(collection);
    const [deleted] = await this.db.inTransaction((open) =>
      guard(
        open.batch([
          { sql: `DELETE FROM ${table} WHERE id = ?`, args: [id] },
          this.clearVersion({ kind: "record", collection, id }),
        ]),
      ),
    );
    return deleted!.rowsAffected > 0;
  }

  protected async backfillVersion(
    target: StoreTarget,
  ): Promise<{ value: string; version: StoreVersion } | null> {
    const row = await this.readVersioned(target);
    if (!row) return null;
    return {
      value: row.value,
      version: row.version ?? (await this.mint(target, [])),
    };
  }
}
// ─── KV facet (AsyncStore + AsyncAtomicMutationStore) ────────────────────────

export type VersionKey = [kind: string, collection: string, key: string];

export function versionKey(target: StoreTarget): VersionKey {
  return target.kind === "key"
    ? ["key", "", target.key]
    : ["record", target.collection, target.id];
}

export function versionedRow(
  rs: ResultSet,
): { value: string; version: StoreVersion | null } | null {
  const row = rs.rows[0];
  if (!row) return null;
  return {
    value: row.value as string,
    version:
      row.version === null || row.version === undefined
        ? null
        : (row.version as StoreVersion),
  };
}
