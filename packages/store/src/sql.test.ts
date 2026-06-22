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
  it("binds a scalar via json_extract = ?", () => {
    const { clause, params } = buildWhereClause({ where: { group: "a" } });
    expect(clause).toBe(" WHERE json_extract(data, ?) = ?");
    expect(params).toEqual(['$."group"', "a"]);
  });
  it("matches an explicit null via json_type = 'null' (not = NULL)", () => {
    const { clause, params } = buildWhereClause({ where: { tag: null } });
    expect(clause).toBe(" WHERE json_type(data, ?) = 'null'");
    expect(params).toEqual(['$."tag"']);
  });
  it("converts booleans to 0/1 (better-sqlite3 rejects raw booleans)", () => {
    expect(buildWhereClause({ where: { ok: true } }).params).toEqual(['$."ok"', 1]);
    expect(buildWhereClause({ where: { ok: false } }).params).toEqual(['$."ok"', 0]);
  });
});

describe("buildOrderBy", () => {
  it("is empty without sortBy", () => {
    expect(buildOrderBy({ where: { a: 1 } })).toEqual({ clause: "", params: [] });
  });
  it("orders nulls last in both directions", () => {
    expect(buildOrderBy({ sortBy: "rank" }).clause).toBe(
      " ORDER BY json_extract(data, ?) IS NULL, json_extract(data, ?) ASC",
    );
    expect(buildOrderBy({ sortBy: "rank", sortDir: "desc" }).clause).toBe(
      " ORDER BY json_extract(data, ?) IS NULL, json_extract(data, ?) DESC",
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
