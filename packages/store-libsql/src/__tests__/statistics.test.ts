import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createClient, type Client } from "@libsql/client";
import { createClient as createWebClient } from "@libsql/client/web";
import { buildOrderBy, buildWhereClause } from "@mirk/store/sql";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { LibsqlAdapter as NodeAdapter } from "../libsql-adapter.js";
import { LibsqlAdapter as RemoteAdapter } from "../remote.js";
import { sqldBinary, startSqld, type Sqld } from "./targets.js";

type Adapter = NodeAdapter | RemoteAdapter;

interface Database {
  client(): Client;
  open(options?: { refreshStatisticsAfterChanges?: number }): Promise<Adapter>;
  dispose(): void;
}

function hex(field: string): string {
  return [...new TextEncoder().encode(field)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Many links share a few types; each `to` names few links. */
async function loadLinks(adapter: Adapter, count: number): Promise<void> {
  for (const field of ["from", "to", "type"]) await adapter.kv.ensureIndex("links", field);
  await adapter.transaction(async () => {
    for (let i = 0; i < count; i++) {
      await adapter.kv.put("links", { id: `l${i}`, from: `r${i % 97}`, to: `r${i}`, type: ["answers", "changes", "serves"][i % 3] });
    }
  });
}

/** The index a fresh connection picks for the store's `{ to, type }` read. */
async function indexFor(database: Database): Promise<string> {
  const client = database.client();
  try {
    const registry = await client.execute("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '%_mirk_tables'");
    const registryTable = String(registry.rows[0]!.name);
    const found = await client.execute(`SELECT table_name FROM ${registryTable} WHERE kind = 'collection' AND name = 'links'`);
    const where = buildWhereClause({ where: { to: "r7", type: "answers" } });
    const rs = await client.execute({
      sql: `EXPLAIN QUERY PLAN SELECT data FROM ${String(found.rows[0]!.table_name)}${where.clause}${buildOrderBy().clause}`,
      args: where.params as never,
    });
    const detail = rs.rows.map((row) => String(row.detail)).join(" ");
    if (detail.includes(`_${hex("to")} `)) return "to";
    if (detail.includes(`_${hex("type")} `)) return "type";
    return detail;
  } finally {
    client.close();
  }
}

function suite(fresh: () => Database): void {
  let database: Database;
  afterEach(() => database?.dispose());

  it("refreshes statistics after a bulk load, so a two-field filter reads the selective index", async () => {
    database = fresh();
    const adapter = await database.open();
    await loadLinks(adapter, 3_000);
    expect(adapter.lastStatisticsRefresh).toMatchObject({ reason: "writes" });
    expect(adapter.lastStatisticsRefresh?.skipped).toBeUndefined();
    expect(await indexFor(database)).toBe("to");
    expect((await adapter.kv.list<{ id: string }>("links", { where: { to: "r7", type: "changes" } })).map((l) => l.id)).toEqual(["l7"]);
    adapter.close();
  });

  it("refreshStatistics() rebuilds them on request and reports the tables", async () => {
    database = fresh();
    const adapter = await database.open({ refreshStatisticsAfterChanges: 0 });
    await loadLinks(adapter, 3_000);
    expect(await indexFor(database)).toBe("type");
    const refresh = await adapter.refreshStatistics();
    expect(refresh.reason).toBe("request");
    expect(refresh.tables.some((table) => table.includes("links"))).toBe(true);
    expect(await indexFor(database)).toBe("to");
    adapter.close();
  });

  it("refreshes statistics when it opens a database that has none", async () => {
    database = fresh();
    const writer = await database.open({ refreshStatisticsAfterChanges: 0 });
    await loadLinks(writer, 3_000);
    writer.close();
    expect(await indexFor(database)).toBe("type");
    const reader = await database.open();
    expect(reader.lastStatisticsRefresh).toMatchObject({ reason: "open" });
    expect(await indexFor(database)).toBe("to");
    reader.close();
  });
}

describe("libSQL file: query statistics", { timeout: 60_000 }, () => {
  suite(() => {
    const directory = mkdtempSync(join(tmpdir(), "mirk-libsql-statistics-"));
    const url = `file:${join(directory, "store.db")}`;
    return {
      client: () => createClient({ url }),
      open: (options) => NodeAdapter.open({ url, ...options }),
      dispose: () => rmSync(directory, { recursive: true, force: true }),
    };
  });
});

describe.runIf(sqldBinary)("libSQL sqld: query statistics", { timeout: 120_000 }, () => {
  let server: Sqld | undefined;
  beforeAll(async () => {
    server = await startSqld(sqldBinary!);
  });
  afterAll(async () => {
    await server?.stop();
  });
  suite(() => ({
    client: () => createWebClient({ url: server!.url }),
    open: (options) => RemoteAdapter.open({ url: server!.url, ...options }),
    dispose: () => {},
  }));
});
