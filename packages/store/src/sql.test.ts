import { describe, it, expect } from "vitest";

import { jsonPath, buildWhereClause, buildOrderBy, buildLimitOffset, hashName } from "./sql.js";

describe("jsonPath", () => {
  it("targets ONE top-level key, even for a dotted name (not a nested path)", () => {
    expect(jsonPath("rank")).toBe('$."rank"');
    expect(jsonPath("a.b")).toBe('$."a.b"');
  });
  it("writes the label as a JSON string, which is how SQLite decodes it", () => {
    expect(jsonPath('a"b')).toBe('$."a\\u0022b"');
    expect(jsonPath("a\\b")).toBe('$."a\\\\b"');
    expect(jsonPath("a\nb")).toBe('$."a\\nb"');
  });
});

describe("buildWhereClause", () => {
  it("is empty for no/blank filter", () => {
    expect(buildWhereClause(undefined)).toEqual({ clause: "", params: [] });
    expect(buildWhereClause({ where: {} })).toEqual({ clause: "", params: [] });
  });
  it("rejects a non-scalar value instead of binding it", () => {
    expect(() => buildWhereClause({ where: { v: { a: 1 } } })).toThrow(
      expect.objectContaining({ name: "StoreFilterError", code: "non-scalar-filter" }),
    );
    expect(() => buildWhereClause({ where: { v: [1, 2] } })).toThrow(
      expect.objectContaining({ name: "StoreFilterError", code: "non-scalar-filter" }),
    );
  });
});

describe("range bounds", () => {
  it("rejects a bound JSON cannot carry: NaN, an infinity or a bigint", () => {
    for (const bound of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 1n]) {
      expect(() => buildWhereClause({ where: { n: { gte: bound } } })).toThrow(
        expect.objectContaining({ name: "StoreFilterError", code: "invalid-range-bound" }),
      );
    }
  });
});

describe("buildOrderBy", () => {
  it("orders by rowid alone without sortBy, pinning insertion order", () => {
    expect(buildOrderBy({ where: { a: 1 } })).toEqual({
      clause: " ORDER BY rowid",
      params: [],
    });
  });
});

describe("buildLimitOffset", () => {
  it("emits LIMIT, and LIMIT -1 to anchor a bare OFFSET", () => {
    expect(buildLimitOffset({ limit: 5 })).toBe(" LIMIT 5");
    expect(buildLimitOffset({ offset: 3 })).toBe(" LIMIT -1 OFFSET 3");
    expect(buildLimitOffset({ limit: 5, offset: 3 })).toBe(" LIMIT 5 OFFSET 3");
    expect(buildLimitOffset({})).toBe("");
  });
});

describe("hashName", () => {
  it("is deterministic and distinguishes names that sanitize alike", () => {
    expect(hashName("foo-bar")).toBe(hashName("foo-bar"));
    expect(hashName("foo-bar")).not.toBe(hashName("foo_bar"));
  });
});
