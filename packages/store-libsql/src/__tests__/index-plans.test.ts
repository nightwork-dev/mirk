import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createClient, type Client, type InStatement } from "@libsql/client";
import { createClient as createWebClient } from "@libsql/client/web";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { LibsqlAdapter as NodeAdapter } from "../libsql-adapter.js";
import { LibsqlAdapter as RemoteAdapter } from "../remote.js";
import { sqldBinary, startSqld, type Sqld } from "./targets.js";

interface Executed {
  sql: string;
  args: unknown[];
}

/** The client the adapter runs on, recording every collection read it makes. */
function recording(client: Client, log: Executed[]): Client {
  return new Proxy(client, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (property !== "execute") return typeof value === "function" ? value.bind(target) : value;
      return (statement: InStatement) => {
        const sql = typeof statement === "string" ? statement : statement.sql;
        const args = typeof statement === "string" ? [] : ((statement.args ?? []) as unknown[]);
        if (/^SELECT (data|COUNT)/.test(sql)) log.push({ sql, args });
        return target.execute(statement);
      };
    },
  });
}

function hex(field: string): string {
  return [...new TextEncoder().encode(field)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

type Kv = NodeAdapter["kv"];

/** Each read Foreclose makes, and the field whose index must serve it. */
const READS: [string, string, (kv: Kv) => Promise<unknown>][] = [
  ["where equality", "sourceRecordId", (kv) => kv.list("sightings", { where: { sourceRecordId: "r7" } })],
  ["listWhereIn", "sourceRecordId", (kv) => kv.listWhereIn("sightings", "sourceRecordId", ["r1", "r2", "r3"])],
  ["sortBy ascending", "rank", (kv) => kv.list("sightings", { sortBy: "rank", limit: 10 })],
  ["sortBy descending", "rank", (kv) => kv.list("sightings", { sortBy: "rank", sortDir: "desc", limit: 10 })],
  ["string range gte", "seenAt", (kv) => kv.list("sightings", { where: { seenAt: { gte: "2026-10-20" } } })],
  ["number range gt", "rank", (kv) => kv.list("sightings", { where: { rank: { gt: 190 } } })],
  ["count over a range", "seenAt", (kv) => kv.count("sightings", { where: { seenAt: { gt: "2026-10-20" } } })],
];

interface Database {
  client(): Client;
  open(client: Client): Promise<NodeAdapter | RemoteAdapter>;
  dispose(): void;
}

async function plans(database: Database, declare: boolean): Promise<Map<string, string>> {
  const log: Executed[] = [];
  const plain = database.client();
  const adapter = await database.open(recording(database.client(), log));
  try {
    const kv = adapter.kv as Kv;
    if (declare) for (const field of ["sourceRecordId", "seenAt", "rank"]) await kv.ensureIndex("sightings", field);
    for (let i = 0; i < 200; i += 1) {
      await kv.put("sightings", {
        id: `s${i}`,
        sourceRecordId: `r${i % 20}`,
        seenAt: `2026-${String(1 + (i % 10)).padStart(2, "0")}-${String(1 + (i % 28)).padStart(2, "0")}`,
        rank: i % 7 === 0 ? null : i,
      });
    }
    const result = new Map<string, string>();
    for (const [label, , read] of READS) {
      log.length = 0;
      await read(kv);
      expect(log, label).toHaveLength(1);
      const rs = await plain.execute({ sql: `EXPLAIN QUERY PLAN ${log[0]!.sql}`, args: log[0]!.args as never });
      result.set(label, rs.rows.map((row) => String(row.detail)).join(" | "));
    }
    return result;
  } finally {
    adapter.close();
    plain.close();
  }
}

function suite(fresh: () => Database): void {
  it("serves every Foreclose read from the declared field's expression index", async () => {
    const database = fresh();
    try {
      const declared = await plans(database, true);
      for (const [label, field] of READS) {
        expect(declared.get(label), label).toMatch(new RegExp(`USING INDEX ix_\\w+_${hex(field)}\\b`));
      }
    } finally {
      database.dispose();
    }
  });

  it("uses no field index when none is declared", async () => {
    const database = fresh();
    try {
      for (const [label, plan] of await plans(database, false)) expect(plan, label).not.toMatch(/USING INDEX ix_/);
    } finally {
      database.dispose();
    }
  });
}

describe("libSQL file: query plans with declared indexes", { timeout: 30_000 }, () => {
  suite(() => {
    const directory = mkdtempSync(join(tmpdir(), "mirk-libsql-plans-"));
    const url = `file:${join(directory, "store.db")}`;
    return {
      client: () => createClient({ url }),
      open: (client) => NodeAdapter.open({ url, client }),
      dispose: () => rmSync(directory, { recursive: true, force: true }),
    };
  });
});

describe.runIf(sqldBinary)("libSQL sqld query plans with declared indexes", { timeout: 60_000 }, () => {
  let server: Sqld | undefined;
  let databases = 0;
  beforeAll(async () => {
    server = await startSqld(sqldBinary!);
  });
  afterAll(async () => {
    await server?.stop();
  });
  suite(() => {
    const tablePrefix = `plans_${++databases}_`;
    return {
      client: () => createWebClient({ url: server!.url }),
      open: (client) => RemoteAdapter.open({ url: server!.url, client, tablePrefix }),
      dispose: () => {},
    };
  });
});
