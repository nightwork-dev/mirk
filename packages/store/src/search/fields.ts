import type { SearchDocument } from "./types.js";

export const DEFAULT_SEARCH_FIELD = "text";

export type SearchInputErrorCode =
  | "text-and-fields"
  | "missing-text-or-fields"
  | "empty-fields"
  | "non-string-field"
  | "field-set-mismatch"
  | "invalid-weight"
  | "unknown-weight-field";

/** Thrown for a malformed search document or field-weight option. */
export class SearchInputError extends Error {
  declare readonly name: "SearchInputError";
  constructor(readonly code: SearchInputErrorCode, message: string) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
Object.defineProperty(SearchInputError.prototype, "name", {
  value: "SearchInputError",
  writable: true,
  configurable: true,
  enumerable: false,
});

export interface NormalizedSearchFields {
  names: string[];
  values: Record<string, string>;
}

export function normalizeSearchDocument(doc: SearchDocument): NormalizedSearchFields {
  if (doc.text !== undefined && doc.fields !== undefined) {
    throw new SearchInputError("text-and-fields", "SearchDocument must provide either `text` or `fields`, not both.");
  }
  if (doc.text !== undefined) {
    return { names: [DEFAULT_SEARCH_FIELD], values: { [DEFAULT_SEARCH_FIELD]: doc.text } };
  }
  if (doc.fields === undefined) {
    throw new SearchInputError("missing-text-or-fields", "SearchDocument must provide `text` or `fields`.");
  }
  const names = Object.keys(doc.fields).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (names.length === 0) throw new SearchInputError("empty-fields", "SearchDocument.fields must contain at least one field.");
  const values: Record<string, string> = {};
  for (const name of names) {
    const value = doc.fields[name];
    if (typeof value !== "string") {
      throw new SearchInputError("non-string-field", `SearchDocument field "${name}" must be a string.`);
    }
    values[name] = value;
  }
  return { names, values };
}

export function assertSameSearchFields(existing: readonly string[], incoming: readonly string[], collection: string): void {
  if (existing.length !== incoming.length || existing.some((name, index) => name !== incoming[index])) {
    throw new SearchInputError(
      "field-set-mismatch",
      `Search collection "${collection}" was initialized with fields [${existing.join(", ")}], got [${incoming.join(", ")}].`,
    );
  }
}

export function assertValidFieldWeightValues(weights?: Record<string, number>): void {
  for (const [field, weight] of Object.entries(weights ?? {})) {
    if (!Number.isFinite(weight) || weight < 0) {
      throw new SearchInputError("invalid-weight", `Search field weight for "${field}" must be a non-negative finite number.`);
    }
  }
}

export function fieldWeightsFor(fields: readonly string[], weights?: Record<string, number>): number[] {
  assertValidFieldWeightValues(weights);
  const fieldSet = new Set(fields);
  for (const field of Object.keys(weights ?? {})) {
    if (!fieldSet.has(field)) throw new SearchInputError("unknown-weight-field", `Unknown search field weight "${field}".`);
  }
  return fields.map((field) => weights?.[field] ?? 1);
}
