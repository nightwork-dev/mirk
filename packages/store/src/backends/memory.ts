// ─── InMemoryStore ────────────────────────────────────────────────────────
// Reference implementation. Map-based. Synchronous. Zero dependencies.
// For tests and lightweight local use.

import type {
  SyncStore,
  SyncStoreInQuery,
  SyncStoreIndexes,
  StoreMeta,
  StoreFilter,
} from "../types.js";
import type {
  AtomicMutationLimits,
  AtomicMutationRequest,
  AtomicMutationResult,
  AtomicCompletedMutationResult,
  StoreCondition,
  StoreTarget,
  StoreVersion,
  SyncAtomicMutationStore,
  SyncReceiptPruning,
  VersionedStoreValue,
} from "../atomic.js";
import {
  cloneJson,
  IN_PROCESS_ATOMIC_LIMITS,
  isReceiptExpired,
  RECEIPT_PRUNE_BATCH,
  resolveAtomicLimits,
  resolveReceiptRetention,
  targetKey,
  validateAtomicRequest,
} from "../atomic.js";
import { compareCodePoints, sortAndPageStoreItems } from "../order.js";
import { assertInValues, assertWhere, inRange, whereCondition } from "../sql.js";

let nextMemoryStoreId = 1;

export interface InMemoryStoreOptions {
  /** Override any of the in-process atomic request bounds. */
  atomicLimits?: Partial<AtomicMutationLimits>;
  /** The prefix every version token this store mints carries. Defaults to a
   *  per-process serial (`m1`, `m2`, …); pin it when tokens themselves are the
   *  thing under comparison, as the conformance corpus does. */
  versionIdentity?: string;
  /** How long, in milliseconds, an idempotency receipt is kept. A request
   *  whose key matches only an expired receipt is applied as new. Defaults to
   *  keeping receipts forever. */
  receiptRetentionMs?: number;
  /** The clock, in milliseconds since the epoch, that stamps and expires
   *  idempotency receipts. Defaults to `Date.now`. */
  now?: () => number;
}

export class InMemoryStore
  implements SyncStore, SyncStoreInQuery, SyncStoreIndexes, SyncAtomicMutationStore, SyncReceiptPruning
{
  readonly meta: StoreMeta = {
    backend: "memory",
  };

  /** The reference runs in-process, so it carries the in-process bounds. */
  readonly atomicLimits: AtomicMutationLimits;
  readonly receiptRetentionMs: number | undefined;
  private readonly now: () => number;

  constructor(options: InMemoryStoreOptions = {}) {
    this.atomicLimits = resolveAtomicLimits(
      options.atomicLimits,
      IN_PROCESS_ATOMIC_LIMITS
    );
    this.receiptRetentionMs = resolveReceiptRetention(options.receiptRetentionMs);
    this.now = options.now ?? Date.now;
    this.versionPrefix = options.versionIdentity ?? `m${nextMemoryStoreId++}`;
  }

  /** Key-value storage. */
  private kv = new Map<string, unknown>();

  /** Collection storage: collection name -> Map of id -> item. */
  private collections = new Map<string, Map<string, unknown>>();

  /** Version metadata is separate from values so deletes never revive tokens. */
  private versions = new Map<string, StoreVersion>();
  private nextVersionNumber = 1;
  private readonly versionPrefix: string;
  private receipts = new Map<
    string,
    {
      requestDigest: string;
      result: AtomicCompletedMutationResult & { status: "applied" };
      createdAt: number;
    }
  >();

  // ── Key-Value ──────────────────────────────────────────────────────

  get<T>(key: string): T | null {
    const value = this.kv.get(key);
    return value !== undefined ? (value as T) : null;
  }

  set<T>(key: string, value: T): void {
    this.kv.set(key, value);
    this.versions.set(targetKey({ kind: "key", key }), this.newVersion());
  }

  has(key: string): boolean {
    return this.kv.has(key);
  }

  delete(key: string): boolean {
    const deleted = this.kv.delete(key);
    if (deleted) this.versions.delete(targetKey({ kind: "key", key }));
    return deleted;
  }

  keys(prefix?: string): string[] {
    const allKeys = [...this.kv.keys()];
    const selected = prefix
      ? allKeys.filter((k) => k.startsWith(prefix))
      : allKeys;
    // Code point ascending, matching the SQLite adapter's `ORDER BY key` under
    // the BINARY collation. Map iteration order (insertion) is not the contract.
    return selected.sort(compareCodePoints);
  }

  // ── Collections ────────────────────────────────────────────────────

  private ensureCollection(name: string): Map<string, unknown> {
    // The SQLite adapter cannot name a table for the empty string and rejects it;
    // the reference used to accept it and quietly serve a collection nobody could
    // address on a persistent backend.
    if (name.length === 0) throw new Error("Invalid collection name");
    let col = this.collections.get(name);
    if (!col) {
      col = new Map<string, unknown>();
      this.collections.set(name, col);
    }
    return col;
  }

  list<T>(collection: string, filter?: StoreFilter): T[] {
    const col = this.ensureCollection(collection);
    let items = [...col.values()] as T[];
    items = applyFilter(items, filter);
    return items;
  }

  listWhereIn<T>(
    collection: string,
    field: string,
    values: readonly unknown[],
    filter?: StoreFilter
  ): T[] {
    if (values.length === 0) return [];
    // Validation order mirrors the SQLite adapter, which builds the caller's
    // WHERE clause before the IN clause.
    if (filter?.where) assertWhere(filter.where);
    assertInValues(values);
    const set = new Set(values);
    const col = this.ensureCollection(collection);
    const items = [...col.values()].filter((item) => {
      if (typeof item !== "object" || item === null) return false;
      return set.has((item as Record<string, unknown>)[field]);
    }) as T[];
    return applyFilter(items, filter);
  }

  /** Accepted and a no-op: the reference scans in memory. */
  ensureIndex(collection: string, _field: string): void {
    this.ensureCollection(collection);
  }

  getById<T>(collection: string, id: string): T | null {
    const col = this.ensureCollection(collection);
    const item = col.get(id);
    return item !== undefined ? (item as T) : null;
  }

  put<T extends { id: string }>(collection: string, item: T): T {
    const col = this.ensureCollection(collection);
    col.set(item.id, item);
    this.versions.set(
      targetKey({ kind: "record", collection, id: item.id }),
      this.newVersion()
    );
    return item;
  }

  remove(collection: string, id: string): boolean {
    const col = this.ensureCollection(collection);
    const removed = col.delete(id);
    if (removed)
      this.versions.delete(targetKey({ kind: "record", collection, id }));
    return removed;
  }

  count(collection: string, filter?: StoreFilter): number {
    const col = this.ensureCollection(collection);
    if (!filter?.where) return col.size;
    // `count` answers "how many match", so it reads only `where`. Routing through
    // applyFilter would also slice, making `count(c, {where, limit: 1})` return 1
    // while the SQLite adapter (which builds a WHERE clause and nothing else)
    // returns the true total.
    const where = filter.where;
    assertWhere(where);
    let total = 0;
    for (const item of col.values()) {
      if (matchesWhere(item, where)) total++;
    }
    return total;
  }

  getVersioned<T>(target: StoreTarget): VersionedStoreValue<T> | null {
    const value =
      target.kind === "key"
        ? (this.kv.get(target.key) as T | undefined)
        : (this.ensureCollection(target.collection).get(target.id) as
            | T
            | undefined);
    if (value === undefined && !this.hasTarget(target)) return null;
    const version = this.versions.get(targetKey(target));
    // Values written by old code before version metadata existed are assigned a
    // token lazily. This keeps the capability useful for an already-populated
    // in-memory instance while preserving write-order semantics thereafter.
    if (!version) {
      const created = this.newVersion();
      this.versions.set(targetKey(target), created);
      return { value: value as T, version: created };
    }
    return { value: value as T, version };
  }

  mutateAtomically(request: AtomicMutationRequest): AtomicMutationResult {
    const validated = validateAtomicRequest(request, this.atomicLimits);
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
        return {
          status: "replayed",
          requestDigest: prior.requestDigest,
          versions: prior.result.versions.map((entry) => ({
            target: cloneTarget(entry.target),
            version: entry.version,
          })),
          ...(prior.result.outcome === undefined
            ? {}
            : { outcome: cloneJson(prior.result.outcome) }),
        };
      }
    }

    // All validation is complete before this point. The reference implementation
    // is synchronous, so no caller can observe an intermediate state while the
    // condition check and operation application run.
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
        case "set":
          this.set(operation.key, cloneJson(operation.value));
          versions.push({
            target,
            version: this.versions.get(targetKey(target))!,
          });
          break;
        case "delete":
          this.delete(operation.key);
          versions.push({ target, version: null });
          break;
        case "put":
          this.put(operation.collection, cloneJson(operation.item));
          versions.push({
            target,
            version: this.versions.get(targetKey(target))!,
          });
          break;
        case "remove":
          this.remove(operation.collection, operation.id);
          versions.push({ target, version: null });
          break;
      }
    }
    const applied: AtomicCompletedMutationResult & { status: "applied" } = {
      status: "applied",
      requestDigest: validated.requestDigest,
      versions,
      ...(validated.outcome === undefined
        ? {}
        : { outcome: cloneJson(validated.outcome) }),
    };
    if (idempotencyKey !== undefined) {
      this.writeReceipt(idempotencyKey, now, {
        requestDigest: validated.requestDigest,
        result: {
          ...applied,
          versions: applied.versions.map((entry) => ({
            target: cloneTarget(entry.target),
            version: entry.version,
          })),
          ...(applied.outcome === undefined
            ? {}
            : { outcome: cloneJson(applied.outcome) }),
        },
      });
    }
    return applied;
  }

  pruneExpiredReceipts(): number {
    if (this.receiptRetentionMs === undefined) return 0;
    const now = this.now();
    let removed = 0;
    for (const [key, receipt] of this.receipts) {
      if (isReceiptExpired(receipt.createdAt, now, this.receiptRetentionMs)) {
        this.receipts.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  // ── Idempotency receipts ──────────────────────────────────────────
  // Every receipt read and write goes through these three methods.

  private readReceipt(key: string, now: number) {
    const receipt = this.receipts.get(key);
    if (!receipt) return undefined;
    return isReceiptExpired(receipt.createdAt, now, this.receiptRetentionMs)
      ? undefined
      : receipt;
  }

  private writeReceipt(
    key: string,
    now: number,
    receipt: {
      requestDigest: string;
      result: AtomicCompletedMutationResult & { status: "applied" };
    }
  ): void {
    // An expired receipt under this key is replaced, and moves to the end of
    // the insertion order with its new creation time.
    this.receipts.delete(key);
    this.receipts.set(key, { ...receipt, createdAt: now });
  }

  /** Delete at most one batch of expired receipts. */
  private pruneReceiptBatch(now: number): number {
    if (this.receiptRetentionMs === undefined) return 0;
    // Receipts are kept in creation order, so the scan stops at the first live
    // one. A clock that stepped back can leave an expired receipt behind a
    // live one; it is still treated as absent and pruned on a later pass.
    let removed = 0;
    for (const [key, receipt] of this.receipts) {
      if (removed >= RECEIPT_PRUNE_BATCH) break;
      if (!isReceiptExpired(receipt.createdAt, now, this.receiptRetentionMs)) break;
      this.receipts.delete(key);
      removed += 1;
    }
    return removed;
  }

  private newVersion(): StoreVersion {
    return `${this.versionPrefix}-v${this.nextVersionNumber++}` as StoreVersion;
  }

  private observe(target: StoreTarget): VersionedStoreValue<unknown> | null {
    const value =
      target.kind === "key"
        ? this.kv.get(target.key)
        : this.ensureCollection(target.collection).get(target.id);
    if (value === undefined && !this.hasTarget(target)) return null;
    const version = this.versions.get(targetKey(target));
    if (!version) {
      const created = this.newVersion();
      this.versions.set(targetKey(target), created);
      return { value, version: created };
    }
    return { value, version };
  }

  private hasTarget(target: StoreTarget): boolean {
    return target.kind === "key"
      ? this.kv.has(target.key)
      : this.ensureCollection(target.collection).has(target.id);
  }
}

function cloneTarget(target: StoreTarget): StoreTarget {
  return target.kind === "key"
    ? { kind: "key", key: target.key }
    : { kind: "record", collection: target.collection, id: target.id };
}

function cloneCondition(condition: StoreCondition): StoreCondition {
  return condition.expected === "version"
    ? {
        target: cloneTarget(condition.target),
        expected: "version",
        version: condition.version,
      }
    : { target: cloneTarget(condition.target), expected: condition.expected };
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

function conditionMatches(
  condition: StoreCondition,
  observed: VersionedStoreValue<unknown> | null
): boolean {
  if (condition.expected === "missing") return observed === null;
  if (condition.expected === "present") return observed !== null;
  return observed !== null && observed.version === condition.version;
}

// ── Filter Logic ───────────────────────────────────────────────────────────

function matchesWhere(item: unknown, where: Record<string, unknown>): boolean {
  if (typeof item !== "object" || item === null) return false;
  const record = item as Record<string, unknown>;
  for (const [key, value] of Object.entries(where)) {
    const condition = whereCondition(value);
    if (condition.kind === "range" ? !inRange(record[key], condition) : record[key] !== condition.value) return false;
  }
  return true;
}

function applyFilter<T>(items: T[], filter?: StoreFilter): T[] {
  if (!filter) return items;

  let result = items;

  // Where clause — exact match
  if (filter.where) {
    const where = filter.where;
    assertWhere(where);
    result = result.filter((item) => matchesWhere(item, where));
  }

  return sortAndPageStoreItems(result, filter);
}
