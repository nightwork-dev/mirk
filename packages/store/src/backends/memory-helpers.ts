import type { StoreCondition, StoreTarget, VersionedStoreValue } from "../atomic.js";
import type { StoreFilter } from "../types.js";
import { sortAndPageStoreItems } from "../order.js";
import { assertWhere, inRange, whereCondition } from "../sql.js";

export function cloneTarget(target: StoreTarget): StoreTarget {
  return target.kind === "key"
    ? { kind: "key", key: target.key }
    : { kind: "record", collection: target.collection, id: target.id };
}

export function cloneCondition(condition: StoreCondition): StoreCondition {
  return condition.expected === "version"
    ? {
        target: cloneTarget(condition.target),
        expected: "version",
        version: condition.version,
      }
    : { target: cloneTarget(condition.target), expected: condition.expected };
}

export function operationTarget(operation: {
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

export function conditionMatches(
  condition: StoreCondition,
  observed: VersionedStoreValue<unknown> | null
): boolean {
  if (condition.expected === "missing") return observed === null;
  if (condition.expected === "present") return observed !== null;
  return observed !== null && observed.version === condition.version;
}

// ── Filter Logic ───────────────────────────────────────────────────────────

export function matchesWhere(item: unknown, where: Record<string, unknown>): boolean {
  if (typeof item !== "object" || item === null) return false;
  const record = item as Record<string, unknown>;
  for (const [key, value] of Object.entries(where)) {
    const condition = whereCondition(value);
    if (condition.kind === "range" ? !inRange(record[key], condition) : record[key] !== condition.value) return false;
  }
  return true;
}

export function applyFilter<T>(items: T[], filter?: StoreFilter): T[] {
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
