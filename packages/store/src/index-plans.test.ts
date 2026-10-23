import { DatabaseSync } from "node:sqlite";
import BetterSqliteDatabase from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { NodeSqliteAdapter } from "./adapters/node-sqlite.js";
import { SqliteAdapter } from "./adapters/sqlite.js";
import type { SqliteAdapterCore } from "./adapters/sqlite-core.js";

interface Raw {
  prepare(sql: string): { all(...params: unknown[]): unknown[] };
}

interface Executed {
  sql: string;
  params: unknown[];
}

/** The connection the adapter runs on, recording every collection read it makes. */
function recording<T extends object>(db: T, log: Executed[]): T {
  const own = <V>(target: object, value: V): V =>
    (typeof value === "function" ? value.bind(target) : value) as V;
  return new Proxy(db, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (property !== "prepare") return own(target, value);
      return (sql: string) => {
        const statement = (value as (sql: string) => object).call(target, sql);
        if (!/^SELECT (data|COUNT)/.test(sql)) return statement;
        return new Proxy(statement, {
          get(s, p) {
            const method = Reflect.get(s, p, s);
            if (p !== "all" && p !== "get") return own(s, method);
            return (...params: unknown[]) => {
              log.push({ sql, params });
              return (method as (...a: unknown[]) => unknown).apply(s, params);
            };
          },
        });
      };
    },
  });
}

function hex(field: string): string {
  return [...new TextEncoder().encode(field)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const DRIVERS: [string, () => { raw: Raw; open: (log: Executed[]) => SqliteAdapterCore }][] = [
  [
    "better-sqlite3",
    () => {
      const raw = new BetterSqliteDatabase(":memory:");
      return { raw, open: (log) => new SqliteAdapter({ path: ":memory:", db: recording(raw, log) }) };
    },
  ],
  [
    "node:sqlite",
    () => {
      const raw = new DatabaseSync(":memory:");
      return { raw, open: (log) => new NodeSqliteAdapter({ path: ":memory:", db: recording(raw, log) }) };
    },
  ],
];

const FIELDS = ["sourceRecordId", "seenAt", "rank"] as const;

/** Each read Foreclose makes, and the field whose index must serve it. */
const READS: [string, keyof typeof FIELDS | (typeof FIELDS)[number], (kv: SqliteAdapterCore["kv"]) => unknown][] = [
  ["where equality", "sourceRecordId", (kv) => kv.list("sightings", { where: { sourceRecordId: "r7" } })],
  ["listWhereIn", "sourceRecordId", (kv) => kv.listWhereIn("sightings", "sourceRecordId", ["r1", "r2", "r3"])],
  ["sortBy ascending", "rank", (kv) => kv.list("sightings", { sortBy: "rank", limit: 10 })],
  ["sortBy descending", "rank", (kv) => kv.list("sightings", { sortBy: "rank", sortDir: "desc", limit: 10 })],
  ["string range gte", "seenAt", (kv) => kv.list("sightings", { where: { seenAt: { gte: "2026-10-20" } } })],
  ["number range gt", "rank", (kv) => kv.list("sightings", { where: { rank: { gt: 1990 } } })],
  ["count over a range", "seenAt", (kv) => kv.count("sightings", { where: { seenAt: { gt: "2026-10-20" } } })],
];

function seed(kv: SqliteAdapterCore["kv"]): void {
  for (let i = 0; i < 2000; i += 1) {
    kv.put("sightings", {
      id: `s${i}`,
      sourceRecordId: `r${i % 200}`,
      seenAt: `2026-${String(1 + (i % 10)).padStart(2, "0")}-${String(1 + (i % 28)).padStart(2, "0")}`,
      rank: i % 7 === 0 ? null : i,
    });
  }
}

describe.each(DRIVERS)("SQLite query plans with declared indexes (%s)", (_name, connect) => {
  function plans(declare: boolean): Map<string, string> {
    const { raw, open } = connect();
    const log: Executed[] = [];
    const adapter = open(log);
    try {
      if (declare) for (const field of FIELDS) adapter.kv.ensureIndex("sightings", field);
      seed(adapter.kv);
      const result = new Map<string, string>();
      for (const [label, , read] of READS) {
        log.length = 0;
        read(adapter.kv);
        expect(log, label).toHaveLength(1);
        const { sql, params } = log[0]!;
        const rows = raw.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as { detail: string }[];
        result.set(label, rows.map((row) => row.detail).join(" | "));
      }
      return result;
    } finally {
      adapter.close();
    }
  }

  it("serves every Foreclose read from the declared field's expression index", () => {
    const declared = plans(true);
    for (const [label, field] of READS) {
      expect(declared.get(label), label).toMatch(new RegExp(`USING INDEX ix_\\w+_${hex(field as string)}\\b`));
    }
  });

  it("uses no field index when none is declared", () => {
    for (const [label, plan] of plans(false)) expect(plan, label).not.toMatch(/USING INDEX ix_/);
  });

  it("declares the index once however often ensureIndex runs", () => {
    const { raw, open } = connect();
    const adapter = open([]);
    try {
      for (let i = 0; i < 3; i += 1) adapter.kv.ensureIndex("sightings", "seenAt");
      const indexes = raw.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'ix_%'").all();
      expect(indexes).toHaveLength(1);
    } finally {
      adapter.close();
    }
  });
});
