import { describe, it, expect } from "vitest";

import { jsonPath, buildWhereClause, buildOrderBy, buildLimitOffset, hashName } from "./sql.js";

describe("jsonPath", () => {
  it("targets ONE top-level key, even for a dotted name (not a nested path)", () => {
    expect(jsonPath("rank")).toBe('$."rank"');
    expect(jsonPath("a.b")).toBe('$."a.b"');
  });
  it('doubles embedded quotes (JSON-path quoting)', () => {
    expect(jsonPath('a"b')).toBe('$."a""b"');
  });
});

describe("buildWhereClause", () => {
  it("is empty for no/blank filter", () => {
    expect(buildWhereClause(undefined)).toEqual({ clause: "", params: [] });
    expect(buildWhereClause({ where: {} })).toEqual({ clause: "", params: [] });
  });
  it("binds a string via a json_type text guard plus json_extract = ?", () => {
    const { clause, params } = buildWhereClause({ where: { group: "a" } });
    expect(clause).toBe(" WHERE json_type(data, ?) = 'text' AND json_extract(data, ?) = ?");
    expect(params).toEqual(['$."group"', '$."group"', "a"]);
  });
  it("binds a number under an integer/real guard, so a stored true cannot match", () => {
    const { clause, params } = buildWhereClause({ where: { n: 1 } });
    expect(clause).toBe(
      " WHERE json_type(data, ?) IN ('integer', 'real') AND json_extract(data, ?) = ?",
    );
    expect(params).toEqual(['$."n"', '$."n"', 1]);
  });
  it("matches an explicit null via json_type = 'null' (not = NULL)", () => {
    const { clause, params } = buildWhereClause({ where: { tag: null } });
    expect(clause).toBe(" WHERE json_type(data, ?) = 'null'");
    expect(params).toEqual(['$."tag"']);
  });
  it("compares booleans by json_type alone, so a stored 1 is not a match", () => {
    expect(buildWhereClause({ where: { ok: true } })).toEqual({
      clause: " WHERE json_type(data, ?) = 'true'",
      params: ['$."ok"'],
    });
    expect(buildWhereClause({ where: { ok: false } })).toEqual({
      clause: " WHERE json_type(data, ?) = 'false'",
      params: ['$."ok"'],
    });
  });
  it("rejects a non-scalar value instead of binding it", () => {
    expect(() => buildWhereClause({ where: { v: { a: 1 } } })).toThrow(
      "Store filters only support JSON scalar values.",
    );
    expect(() => buildWhereClause({ where: { v: [1, 2] } })).toThrow(
      "Store filters only support JSON scalar values.",
    );
  });
});

describe("buildOrderBy", () => {
  it("orders by rowid alone without sortBy, pinning insertion order", () => {
    expect(buildOrderBy({ where: { a: 1 } })).toEqual({
      clause: " ORDER BY rowid",
      params: [],
    });
  });
  it("orders nulls last in both directions, with rowid as the tie-break", () => {
    expect(buildOrderBy({ sortBy: "rank" }).clause).toBe(
      " ORDER BY json_extract(data, ?) IS NULL, json_extract(data, ?) ASC, rowid",
    );
    expect(buildOrderBy({ sortBy: "rank", sortDir: "desc" }).clause).toBe(
      " ORDER BY json_extract(data, ?) IS NULL, json_extract(data, ?) DESC, rowid",
    );
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
