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
import { compareCodePoints } from "../order.js";
import { NON_SCALAR_FILTER_MESSAGE } from "../sql.js";

/** The message the SQLite adapter already raises for a non-scalar `listWhereIn`
 *  value. The reference raises the same one so the two backends agree. */
const NON_SCALAR_IN_MESSAGE = "Store IN queries only support JSON scalar values.";

function isJsonScalar(value: unknown): boolean {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  );
}

/** There is no deep equality anywhere in the port, so a non-scalar `where` value
 *  is a caller error. The SQLite adapter cannot bind one at all; the reference
 *  used to return `[]` and silently mean "no match". */
function assertScalarWhere(where: Record<string, unknown>): void {
  for (const value of Object.values(where)) {
    if (!isJsonScalar(value)) throw new Error(NON_SCALAR_FILTER_MESSAGE);
  }
}

function assertScalarInValues(values: readonly unknown[]): void {
  for (const value of values) {
    if (!isJsonScalar(value)) throw new Error(NON_SCALAR_IN_MESSAGE);
  }
}

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
    if (filter?.where) assertScalarWhere(filter.where);
    assertScalarInValues(values);
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
    // `count` answers "how many match", so it reads only `where`. Routing through
    // applyFilter would also slice, making `count(c, {where, limit: 1})` return 1
    // while the SQLite adapter (which builds a WHERE clause and nothing else)
    // returns the true total.
    const where = filter.where;
    assertScalarWhere(where);
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
    assertScalarWhere(where);
    result = result.filter((item) => matchesWhere(item, where));
  }

  // Sort — stable, so ties keep insertion order
  if (filter.sortBy) {
    const field = filter.sortBy;
    const dir = filter.sortDir === "desc" ? -1 : 1;
    result = [...result].sort((a, b) => {
      const aVal = (a as Record<string, unknown>)[field];
      const bVal = (b as Record<string, unknown>)[field];
      const aMissing = aVal === undefined || aVal === null;
      const bMissing = bVal === undefined || bVal === null;
      // Null and missing sort LAST in both directions, so the direction
      // multiplier deliberately does not apply to them.
      if (aMissing && bMissing) return 0;
      if (aMissing) return 1;
      if (bMissing) return -1;
      if (aVal === bVal) return 0;
      if (typeof aVal === "string" && typeof bVal === "string") {
        // JS `<` on strings compares UTF-16 code units; SQLite's BINARY
        // collation compares UTF-8 bytes. They differ above the BMP.
        return compareCodePoints(aVal, bVal) * dir;
      }
      return aVal < bVal ? -1 * dir : 1 * dir;
    });
  }

  // Offset, then limit — both after the sort
  if (filter.offset !== undefined && filter.offset > 0) {
    result = result.slice(Math.floor(filter.offset));
  }

  // A negative limit clamps to zero (no rows), matching the SQLite adapter's
  // `LIMIT max(0, floor(limit))`. Returning everything for `limit: -1` was the
  // reference's own reading of "no limit".
  if (filter.limit !== undefined) {
    result = result.slice(0, Math.max(0, Math.floor(filter.limit)));
  }

  return result;
}
