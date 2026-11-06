import type { InStatement, ResultSet } from "@libsql/client";
import type {
  AsyncReceiptPruning,
  AtomicCompletedMutationResult,
} from "@mirk/store";
import { RECEIPT_PRUNE_BATCH } from "@mirk/store/atomic";
import type { LibsqlDatabase } from "./libsql-database.js";
import type { TableNames } from "./libsql-registry.js";
import { guard } from "./libsql-errors.js";

export class LibsqlReceiptStorage implements AsyncReceiptPruning {
  constructor(
    protected readonly db: LibsqlDatabase,
    protected readonly names: TableNames,
    readonly receiptRetentionMs: number | undefined,
    protected readonly now: (() => number) | undefined,
  ) {}
  async pruneExpiredReceipts(): Promise<number> {
    if (this.receiptRetentionMs === undefined) return 0;
    let removed = 0;
    for (;;) {
      const batch = await this.write(() =>
        this.pruneReceiptBatch(this.clock()),
      );
      removed += batch;
      if (batch < RECEIPT_PRUNE_BATCH) return removed;
    }
  }

  // ─── Idempotency receipts ──────────────────────────────────────────────────
  // Every receipt read and write uses these statements. `now` is the injected
  // clock's reading, or null to use the database's clock.

  protected clock(): number | null {
    return this.now === undefined ? null : this.now();
  }

  /** Selects the live receipt under `key`; see `receiptRow`. */
  protected readReceiptStatement(key: string, now: number | null): InStatement {
    const live =
      this.receiptRetentionMs === undefined
        ? ""
        : ` AND (created_at IS NULL OR created_at >= ${NOW_MS_SQL} - ?)`;
    return {
      sql: `SELECT request_digest, result_json FROM ${this.names.receipts} WHERE idempotency_key = ?${live}`,
      args:
        this.receiptRetentionMs === undefined
          ? [key]
          : [key, now, this.receiptRetentionMs],
    };
  }

  /** Writes a receipt, replacing an expired one under the same key. */
  protected writeReceiptStatement(
    key: string,
    requestDigest: string,
    result: AtomicCompletedMutationResult,
    now: number | null,
  ): InStatement {
    return {
      sql: `INSERT INTO ${this.names.receipts} (idempotency_key, request_digest, result_json, created_at)
            VALUES (?, ?, ?, ${NOW_MS_SQL})
            ON CONFLICT(idempotency_key) DO UPDATE SET request_digest = excluded.request_digest,
              result_json = excluded.result_json, created_at = excluded.created_at`,
      args: [key, requestDigest, JSON.stringify(result), now],
    };
  }

  /** Stamps at most one batch of receipts that have no creation time with
   *  now, then deletes at most one batch of expired receipts. None when
   *  receipts are kept forever. */
  protected pruneReceiptStatements(now: number | null): InStatement[] {
    const retention = this.receiptRetentionMs;
    if (retention === undefined) return [];
    const table = this.names.receipts;
    return [
      {
        sql: `UPDATE ${table} SET created_at = ${NOW_MS_SQL} WHERE idempotency_key IN (
                SELECT idempotency_key FROM ${table} WHERE created_at IS NULL LIMIT ?)`,
        args: [now, RECEIPT_PRUNE_BATCH],
      },
      {
        sql: `DELETE FROM ${table} WHERE idempotency_key IN (
                SELECT idempotency_key FROM ${table} WHERE created_at < ${NOW_MS_SQL} - ?
                ORDER BY created_at LIMIT ?)`,
        args: [now, retention, RECEIPT_PRUNE_BATCH],
      },
    ];
  }

  /** In the open transaction and one round trip, prune one batch of
   *  receipts. Returns how many were deleted. */
  protected async pruneReceiptBatch(now: number | null): Promise<number> {
    const statements = this.pruneReceiptStatements(now);
    if (statements.length === 0) return 0;
    const [, deleted] = await this.db.inTransaction((open) =>
      guard(open.batch(statements)),
    );
    return deleted!.rowsAffected;
  }

  /** Every write runs in a write transaction: its own, or a savepoint of the
   *  caller's, so the data and its version token change together. */
  protected write<T>(work: () => Promise<T>): Promise<T> {
    return this.db.transactions.transaction(work);
  }
}
/** "Now" in milliseconds since the epoch: the bound injected reading, or the
 *  database's clock when that argument is null. */
const NOW_MS_SQL = "COALESCE(?, CAST(unixepoch('subsec') * 1000 AS INTEGER))";

export function receiptRow(
  rs: ResultSet,
): { requestDigest: string; result: AtomicCompletedMutationResult } | null {
  const row = rs.rows[0];
  if (!row) return null;
  return {
    requestDigest: row.request_digest as string,
    result: JSON.parse(
      row.result_json as string,
    ) as AtomicCompletedMutationResult,
  };
}
