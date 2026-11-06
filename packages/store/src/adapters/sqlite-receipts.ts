import { type SqliteDb } from "./sqlite-driver.js";
import type { AtomicMutationResult, SyncReceiptPruning } from "../atomic.js";
import { isReceiptExpired, RECEIPT_PRUNE_BATCH } from "../atomic.js";
export class SqliteReceiptStorage implements SyncReceiptPruning {
  constructor(
    protected readonly db: SqliteDb,
    readonly receiptRetentionMs: number | undefined,
    protected readonly now: () => number,
  ) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS _mirk_atomic_receipts (
        idempotency_key TEXT PRIMARY KEY,
        request_digest TEXT NOT NULL,
        result_json TEXT NOT NULL,
        created_at INTEGER
      );
    `);
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS _mirk_atomic_receipts_created_at ON _mirk_atomic_receipts (created_at)",
    );
  }
  pruneExpiredReceipts(): number {
    if (this.receiptRetentionMs === undefined) return 0;
    let removed = 0;
    for (;;) {
      const batch = this.db.transaction(() =>
        this.pruneReceiptBatch(this.now()),
      );
      const count = batch.immediate();
      removed += count;
      if (count < RECEIPT_PRUNE_BATCH) return removed;
    }
  }

  // ─── Idempotency receipts ────────────────────────────────────────────────
  // Every receipt read and write goes through these three methods. The same
  // table and rules are shared with @mirk/store-libsql.

  /** The live receipt under `key`, or undefined when there is none or it has
   *  expired. */
  protected readReceipt(
    key: string,
    now: number,
  ): { requestDigest: string; resultJson: string } | undefined {
    const row = this.db
      .prepare(
        "SELECT request_digest as requestDigest, result_json as resultJson, created_at as createdAt FROM _mirk_atomic_receipts WHERE idempotency_key = ?",
      )
      .get(key) as
      | {
          requestDigest: string;
          resultJson: string;
          createdAt: number | bigint | null;
        }
      | undefined;
    if (!row) return undefined;
    const createdAt = row.createdAt === null ? null : Number(row.createdAt);
    return isReceiptExpired(createdAt, now, this.receiptRetentionMs)
      ? undefined
      : row;
  }

  /** Write a receipt, replacing an expired one under the same key. */
  protected writeReceipt(
    key: string,
    requestDigest: string,
    result: AtomicMutationResult,
    now: number,
  ): void {
    this.db
      .prepare(
        `INSERT INTO _mirk_atomic_receipts (idempotency_key, request_digest, result_json, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(idempotency_key) DO UPDATE SET request_digest = excluded.request_digest,
           result_json = excluded.result_json, created_at = excluded.created_at`,
      )
      .run(key, requestDigest, JSON.stringify(result), now);
  }

  /** In the open transaction, stamp at most one batch of receipts that have no
   *  creation time with `now`, then delete at most one batch of expired
   *  receipts. Returns how many were deleted. */
  protected pruneReceiptBatch(now: number): number {
    if (this.receiptRetentionMs === undefined) return 0;
    this.db
      .prepare(
        `UPDATE _mirk_atomic_receipts SET created_at = ? WHERE idempotency_key IN (
           SELECT idempotency_key FROM _mirk_atomic_receipts WHERE created_at IS NULL LIMIT ?)`,
      )
      .run(now, RECEIPT_PRUNE_BATCH);
    return Number(
      this.db
        .prepare(
          `DELETE FROM _mirk_atomic_receipts WHERE idempotency_key IN (
           SELECT idempotency_key FROM _mirk_atomic_receipts WHERE created_at < ? ORDER BY created_at LIMIT ?)`,
        )
        .run(now - this.receiptRetentionMs, RECEIPT_PRUNE_BATCH).changes,
    );
  }
}
