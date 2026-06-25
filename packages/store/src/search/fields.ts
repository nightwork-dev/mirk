import type { SearchDocument } from "./types.js";

export const DEFAULT_SEARCH_FIELD = "text";

export interface NormalizedSearchFields {
  names: string[];
  values: Record<string, string>;
}

export function normalizeSearchDocument(doc: SearchDocument): NormalizedSearchFields {
  if (doc.text !== undefined && doc.fields !== undefined) {
    throw new Error("SearchDocument must provide either `text` or `fields`, not both.");
  }
  if (doc.text !== undefined) {
    return { names: [DEFAULT_SEARCH_FIELD], values: { [DEFAULT_SEARCH_FIELD]: doc.text } };
  }
  if (doc.fields === undefined) {
    throw new Error("SearchDocument must provide `text` or `fields`.");
  }
  const names = Object.keys(doc.fields).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (names.length === 0) throw new Error("SearchDocument.fields must contain at least one field.");
  const values: Record<string, string> = {};
  for (const name of names) {
    const value = doc.fields[name];
    if (typeof value !== "string") {
      throw new Error(`SearchDocument field "${name}" must be a string.`);
    }
    values[name] = value;
  }
  return { names, values };
}

export function assertSameSearchFields(existing: readonly string[], incoming: readonly string[], collection: string): void {
  if (existing.length !== incoming.length || existing.some((name, index) => name !== incoming[index])) {
    throw new Error(
      `Search collection "${collection}" was initialized with fields [${existing.join(", ")}], got [${incoming.join(", ")}].`,
    );
  }
}

export function assertValidFieldWeightValues(weights?: Record<string, number>): void {
  for (const [field, weight] of Object.entries(weights ?? {})) {
    if (!Number.isFinite(weight) || weight < 0) {
      throw new Error(`Search field weight for "${field}" must be a non-negative finite number.`);
    }
  }
}

export function fieldWeightsFor(fields: readonly string[], weights?: Record<string, number>): number[] {
  assertValidFieldWeightValues(weights);
  const fieldSet = new Set(fields);
  for (const field of Object.keys(weights ?? {})) {
    if (!fieldSet.has(field)) throw new Error(`Unknown search field weight "${field}".`);
  }
  return fields.map((field) => weights?.[field] ?? 1);
}
