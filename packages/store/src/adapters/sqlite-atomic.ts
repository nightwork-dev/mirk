import { type SqliteDb } from "./sqlite-driver.js";
import type {
  AtomicMutationLimits,
  AtomicMutationRequest,
  AtomicMutationResult,
  StoreCondition,
  StoreTarget,
  StoreVersion,
  SyncAtomicMutationStore,
  VersionedStoreValue,
} from "../atomic.js";
import {
  AtomicMutationBackendError,
  cloneJson,
  IN_PROCESS_ATOMIC_LIMITS,
  validateAtomicRequest,
} from "../atomic.js";
import { isSqliteBusyOrLocked } from "../sqlite-busy.js";
import { randomUUID } from "node:crypto";
import { SqliteReceiptStorage } from "./sqlite-receipts.js";
export abstract class SqliteAtomicFacet
  extends SqliteReceiptStorage
  implements SyncAtomicMutationStore
{
  private readonly versionPrefix: string;
  protected abstract ensureTable(collection: string): string;
  protected abstract tableIfExists(collection: string): string | null;
  constructor(
    db: SqliteDb,
    readonly atomicLimits: AtomicMutationLimits = IN_PROCESS_ATOMIC_LIMITS,
    versionIdentity?: string,
    receiptRetentionMs: number | undefined = undefined,
    now: () => number = Date.now,
  ) {
    super(db, receiptRetentionMs, now);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS _mirk_atomic_versions (
        kind TEXT NOT NULL,
        collection TEXT NOT NULL,
        target_key TEXT NOT NULL,
        version TEXT NOT NULL,
        PRIMARY KEY (kind, collection, target_key)
      );
      CREATE TABLE IF NOT EXISTS _mirk_atomic_sequence (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        value INTEGER NOT NULL
      );
      INSERT OR IGNORE INTO _mirk_atomic_sequence (id, value) VALUES (1, 0);
      CREATE TABLE IF NOT EXISTS _mirk_atomic_identity (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        value TEXT NOT NULL
      );
    `);
    this.db
      .prepare(
        "INSERT OR IGNORE INTO _mirk_atomic_identity (id, value) VALUES (1, ?)",
      )
      .run(versionIdentity ?? randomUUID());
    this.versionPrefix = (
      this.db
        .prepare("SELECT value FROM _mirk_atomic_identity WHERE id = 1")
        .get() as { value: string }
    ).value;
  }

  getVersioned<T>(target: StoreTarget): VersionedStoreValue<T> | null {
    return this.readVersionedTarget<T>(target);
  }

  mutateAtomically(request: AtomicMutationRequest): AtomicMutationResult {
    const validated = validateAtomicRequest(request, this.atomicLimits);
    const transaction = this.db.transaction(() => this.decideAtomic(validated));
    try {
      return transaction.immediate();
    } catch (error) {
      if (isSqliteBusyOrLocked(error)) {
        throw new AtomicMutationBackendError(
          "unavailable",
          true,
          "SQLite is busy or locked.",
        );
      }
      throw error;
    }
  }

  private decideAtomic(
    validated: ReturnType<typeof validateAtomicRequest>,
  ): AtomicMutationResult {
    const idempotencyKey = validated.idempotency?.key;
    const now = idempotencyKey === undefined ? 0 : this.now();
    if (idempotencyKey !== undefined) {
      this.pruneReceiptBatch(now);
      const prior = this.readReceipt(idempotencyKey, now);
      if (prior) {
        if (prior.requestDigest !== validated.requestDigest) {
          return {
            status: "idempotency-conflict",
            key: idempotencyKey,
            expectedRequestDigest: prior.requestDigest,
            receivedRequestDigest: validated.requestDigest,
          };
        }
        const result = JSON.parse(prior.resultJson) as Extract<
          AtomicMutationResult,
          { status: "applied" | "replayed" }
        >;
        return {
          status: "replayed",
          requestDigest: result.requestDigest,
          versions: result.versions,
          ...(result.outcome === undefined ? {} : { outcome: result.outcome }),
        };
      }
    }

    for (const condition of validated.conditions) {
      const observed = this.observe(condition.target);
      if (!conditionMatches(condition, observed)) {
        return {
          status: "conflict",
          condition: cloneCondition(condition),
          observed:
            observed === null
              ? "missing"
              : condition.expected === "version"
                ? observed.version
                : "present",
        };
      }
    }

    const versions: { target: StoreTarget; version: StoreVersion | null }[] =
      [];
    for (const operation of validated.operations) {
      const target = operationTarget(operation);
      switch (operation.op) {
        case "set": {
          this.db
            .prepare(
              `INSERT INTO _kv (key, value, updated_at) VALUES (?, ?, datetime('now'))
             ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
            )
            .run(operation.key, JSON.stringify(operation.value));
          versions.push({ target, version: this.writeVersion(target) });
          break;
        }
        case "delete":
          this.db.prepare("DELETE FROM _kv WHERE key = ?").run(operation.key);
          this.clearVersion(target);
          versions.push({ target, version: null });
          break;
        case "put": {
          const table = this.ensureTable(operation.collection);
          this.db
            .prepare(
              `INSERT INTO ${table} (id, data, updated_at) VALUES (?, ?, datetime('now'))
             ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = datetime('now')`,
            )
            .run(operation.item.id, JSON.stringify(operation.item));
          versions.push({ target, version: this.writeVersion(target) });
          break;
        }
        case "remove": {
          const table = this.tableIfExists(operation.collection);
          if (table)
            this.db
              .prepare(`DELETE FROM ${table} WHERE id = ?`)
              .run(operation.id);
          this.clearVersion(target);
          versions.push({ target, version: null });
          break;
        }
      }
    }
    const applied: Extract<
      AtomicMutationResult,
      { status: "applied" | "replayed" }
    > & { status: "applied" } = {
      status: "applied",
      requestDigest: validated.requestDigest,
      versions,
      ...(validated.outcome === undefined
        ? {}
        : { outcome: cloneJson(validated.outcome) }),
    };
    if (idempotencyKey !== undefined)
      this.writeReceipt(idempotencyKey, validated.requestDigest, applied, now);
    return applied;
  }

  private observe(target: StoreTarget): VersionedStoreValue<unknown> | null {
    return this.readVersionedTarget(target);
  }

  private readVersionedTarget<T>(
    target: StoreTarget,
  ): VersionedStoreValue<T> | null {
    if (target.kind === "key") {
      const row = this.db
        .prepare(
          `SELECT k.value, v.version
           FROM _kv AS k
           LEFT JOIN _mirk_atomic_versions AS v
             ON v.kind = 'key' AND v.collection = '' AND v.target_key = k.key
          WHERE k.key = ?`,
        )
        .get(target.key) as
        | { value: string; version?: string | null }
        | undefined;
      if (!row) return null;
      const version =
        row.version == null
          ? this.writeVersion(target)
          : (row.version as StoreVersion);
      return { value: JSON.parse(row.value) as T, version };
    }
    const table = this.tableIfExists(target.collection);
    if (!table) return null;
    const row = this.db
      .prepare(
        `SELECT c.data, v.version
         FROM ${table} AS c
         LEFT JOIN _mirk_atomic_versions AS v
           ON v.kind = 'record' AND v.collection = ? AND v.target_key = c.id
        WHERE c.id = ?`,
      )
      .get(target.collection, target.id) as
      | { data: string; version?: string | null }
      | undefined;
    if (!row) return null;
    const version =
      row.version == null
        ? this.writeVersion(target)
        : (row.version as StoreVersion);
    return { value: JSON.parse(row.data) as T, version };
  }

  protected writeVersion(target: StoreTarget): StoreVersion {
    const parts =
      target.kind === "key"
        ? ["key", "", target.key]
        : ["record", target.collection, target.id];
    // One statement, so another process cannot mint between the increment
    // and the read when this runs outside a transaction.
    const row = this.db
      .prepare(
        "UPDATE _mirk_atomic_sequence SET value = value + 1 WHERE id = 1 RETURNING value",
      )
      .get() as { value: number };
    const version = `${this.versionPrefix}-v${row.value}` as StoreVersion;
    this.db
      .prepare(
        `INSERT INTO _mirk_atomic_versions (kind, collection, target_key, version) VALUES (?, ?, ?, ?)
       ON CONFLICT(kind, collection, target_key) DO UPDATE SET version = excluded.version`,
      )
      .run(...parts, version);
    return version;
  }

  protected clearVersion(target: StoreTarget): void {
    const parts =
      target.kind === "key"
        ? ["key", "", target.key]
        : ["record", target.collection, target.id];
    this.db
      .prepare(
        "DELETE FROM _mirk_atomic_versions WHERE kind = ? AND collection = ? AND target_key = ?",
      )
      .run(...parts);
  }
}

function operationTarget(operation: {
  op: string;
  key?: string;
  collection?: string;
  id?: string;
  item?: { id: string };
}): StoreTarget {
  if (operation.op === "set" || operation.op === "delete")
    return { kind: "key", key: operation.key! };
  if (operation.op === "put")
    return {
      kind: "record",
      collection: operation.collection!,
      id: operation.item!.id,
    };
  return {
    kind: "record",
    collection: operation.collection!,
    id: operation.id!,
  };
}

function cloneCondition(condition: StoreCondition): StoreCondition {
  return condition.expected === "version"
    ? {
        target: { ...condition.target },
        expected: "version",
        version: condition.version,
      }
    : { target: { ...condition.target }, expected: condition.expected };
}

function conditionMatches(
  condition: StoreCondition,
  observed: VersionedStoreValue<unknown> | null,
): boolean {
  if (condition.expected === "missing") return observed === null;
  if (condition.expected === "present") return observed !== null;
  return observed !== null && observed.version === condition.version;
}
