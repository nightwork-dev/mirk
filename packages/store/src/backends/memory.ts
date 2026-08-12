// ─── InMemoryStore ────────────────────────────────────────────────────────
// Reference implementation. Map-based. Synchronous. Zero dependencies.
// For tests and lightweight local use.

import type {
  SyncStore,
  SyncStoreInQuery,
  StoreMeta,
  StoreFilter,
} from "../types.js";
import type {
  AtomicMutationRequest,
  AtomicMutationResult,
  AtomicCompletedMutationResult,
  StoreCondition,
  StoreTarget,
  StoreVersion,
  SyncAtomicMutationStore,
  VersionedStoreValue,
} from "../atomic.js";
import { cloneJson, targetKey, validateAtomicRequest } from "../atomic.js";

let nextMemoryStoreId = 1;

export class InMemoryStore
  implements SyncStore, SyncStoreInQuery, SyncAtomicMutationStore
{
  readonly meta: StoreMeta = {
    backend: "memory",
  };

  /** Key-value storage. */
  private kv = new Map<string, unknown>();

  /** Collection storage: collection name -> Map of id -> item. */
  private collections = new Map<string, Map<string, unknown>>();

  /** Version metadata is separate from values so deletes never revive tokens. */
  private versions = new Map<string, StoreVersion>();
  private nextVersionNumber = 1;
  private readonly versionPrefix = `m${nextMemoryStoreId++}`;
  private receipts = new Map<
    string,
    {
      requestDigest: string;
      result: AtomicCompletedMutationResult & { status: "applied" };
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
    if (!prefix) return allKeys;
    return allKeys.filter((k) => k.startsWith(prefix));
  }

  // ── Collections ────────────────────────────────────────────────────

  private ensureCollection(name: string): Map<string, unknown> {
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
    const set = new Set(values);
    const col = this.ensureCollection(collection);
    const items = [...col.values()].filter((item) => {
      if (typeof item !== "object" || item === null) return false;
      return set.has((item as Record<string, unknown>)[field]);
    }) as T[];
    return applyFilter(items, filter);
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
    const items = [...col.values()];
    return applyFilter(items, filter).length;
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
    const validated = validateAtomicRequest(request);
    const idempotencyKey = validated.idempotency?.key;
    if (idempotencyKey !== undefined) {
      const prior = this.receipts.get(idempotencyKey);
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
      this.receipts.set(idempotencyKey, {
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
    if (record[key] !== value) return false;
  }
  return true;
}

function applyFilter<T>(items: T[], filter?: StoreFilter): T[] {
  if (!filter) return items;

  let result = items;

  // Where clause — exact match
  if (filter.where) {
    const where = filter.where;
    result = result.filter((item) => matchesWhere(item, where));
  }

  // Sort
  if (filter.sortBy) {
    const field = filter.sortBy;
    const dir = filter.sortDir === "desc" ? -1 : 1;
    result = [...result].sort((a, b) => {
      const aVal = (a as Record<string, unknown>)[field];
      const bVal = (b as Record<string, unknown>)[field];
      if (aVal === bVal) return 0;
      if (aVal === undefined || aVal === null) return 1;
      if (bVal === undefined || bVal === null) return -1;
      return aVal < bVal ? -1 * dir : 1 * dir;
    });
  }

  // Offset
  if (filter.offset !== undefined && filter.offset > 0) {
    result = result.slice(filter.offset);
  }

  // Limit
  if (filter.limit !== undefined && filter.limit >= 0) {
    result = result.slice(0, filter.limit);
  }

  return result;
}
