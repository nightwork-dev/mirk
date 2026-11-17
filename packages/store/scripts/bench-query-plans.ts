// Times reads whose speed depends on SQLite's query planner, on a store shaped
// like a record-and-link application: `links` ({ from, to, type }) and
// `membership` ({ product, record, kind, state, score }), each field declared
// with `ensureIndex`. It prints one JSON line per measurement; it asserts
// nothing.
//
//   pnpm --filter @mirk/store exec tsx scripts/bench-query-plans.ts [links] [membership]
//
// Phases, each on a fresh connection to the same file:
//   opened    — the file as the adapter leaves it after loading and reopening
//   analyzed  — after a full `ANALYZE` on the raw connection
//   composite — after `ensureIndex("membership", ["product", "kind", "state"])`
//
// `one-link` is a two-term filter on links ({ to, type }). `ranked` is
// `listWhereIn` on product with { kind, state } and a sorted page. `write` is
// one immediate transaction that reads links for three targets and writes
// three membership rows, the shape of an application's ripple write.
import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NodeSqliteAdapter } from "../src/adapters/node-sqlite.js";

const LINKS = Number(process.argv[2] ?? 300_000);
const MEMBERSHIP = Number(process.argv[3] ?? 600_000);
const PRODUCTS = 250;
const RUNS = 30;

const TYPES = [
  ["answers", 21], ["changes", 19], ["source_of", 22], ["serves", 15], ["narrower_than", 4], ["concerns", 3.5],
  ["delivers", 3], ["part_of", 6], ["governs", 3], ["grounds", 2], ["supports", 1], ["waits_on", 0.5],
] as const;
const KINDS = [
  ["problem", 4], ["source", 15], ["story", 7], ["criterion", 9], ["placement", 12], ["assessment", 9],
  ["evaluation", 9], ["task", 6], ["lane", 2], ["claim", 3], ["proposal", 1], ["assumption", 2],
] as const;
const STATES = ["open", "solved", "draft", "closed", "parked"];

let seed = 7;
function random(): number {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
}
function weighted<T extends readonly (readonly [string, number])[]>(table: T): string {
  const total = table.reduce((sum, [, weight]) => sum + weight, 0);
  let roll = random() * total;
  for (const [name, weight] of table) if ((roll -= weight) <= 0) return name;
  return table[0]![0];
}

const dir = mkdtempSync(join(tmpdir(), "mirk-bench-plans-"));
const path = join(dir, "store.db");
const out = (row: Record<string, unknown>) => console.log(JSON.stringify(row));

function open(): { raw: DatabaseSync; adapter: NodeSqliteAdapter } {
  const raw = new DatabaseSync(path);
  return { raw, adapter: new NodeSqliteAdapter({ path, db: raw }) };
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return +sorted[Math.floor(sorted.length / 2)]!.toFixed(3);
}

function plan(raw: DatabaseSync, sql: string, params: unknown[]): string {
  return (raw.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...(params as never[])) as { detail: string }[])
    .map((row) => row.detail)
    .join(" | ");
}

const targets: string[] = [];
{
  const { adapter } = open();
  for (const field of ["from", "to", "type"]) adapter.kv.ensureIndex("links", field);
  for (const field of ["product", "record", "kind", "state", "score"]) adapter.kv.ensureIndex("membership", field);
  const started = performance.now();
  for (let i = 0; i < LINKS; i += 5_000) {
    adapter.transaction(() => {
      for (let j = i; j < Math.min(LINKS, i + 5_000); j++) {
        const to = `r${Math.floor(random() * (LINKS / 3))}`;
        if (j % 9_973 === 0) targets.push(to);
        adapter.kv.put("links", { id: `l${j}`, from: `r${Math.floor(random() * (LINKS / 3))}`, to, type: weighted(TYPES) });
      }
    }, "immediate");
  }
  for (let i = 0; i < MEMBERSHIP; i += 5_000) {
    adapter.transaction(() => {
      for (let j = i; j < Math.min(MEMBERSHIP, i + 5_000); j++) {
        const kind = weighted(KINDS);
        adapter.kv.put("membership", {
          id: `m${j}`,
          product: `p${Math.floor(random() ** 2 * PRODUCTS)}`,
          record: `r${Math.floor(random() * (MEMBERSHIP / 3))}`,
          kind,
          state: STATES[Math.floor(random() ** 1.5 * STATES.length)],
          score: Math.round(random() * 1000),
        });
      }
    }, "immediate");
  }
  out({ phase: "load", links: LINKS, membership: MEMBERSHIP, ms: Math.round(performance.now() - started), lastRefresh: (adapter as { lastStatisticsRefresh?: unknown }).lastStatisticsRefresh });
  adapter.close();
}

const scope = ["p40", "p41", "p42", "p43"];

function measure(phase: string): void {
  const { raw, adapter } = open();
  const kv = adapter.kv;
  out({ phase, openRefresh: (adapter as { lastStatisticsRefresh?: unknown }).lastStatisticsRefresh });
  const stat = raw.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'sqlite_stat1'").get() as { n: number };
  const statRows = stat.n ? (raw.prepare("SELECT count(*) AS n FROM sqlite_stat1").get() as { n: number }).n : 0;

  const linkTable = (raw.prepare("SELECT table_name FROM _mirk_tables WHERE name = 'links'").get() as { table_name: string }).table_name;
  const memTable = (raw.prepare("SELECT table_name FROM _mirk_tables WHERE name = 'membership'").get() as { table_name: string }).table_name;
  const oneLinkSql = `SELECT data FROM ${linkTable} WHERE json_extract(data, '$."to"') = ? AND json_type(data, '$."to"') = 'text' AND json_extract(data, '$."type"') = ? AND json_type(data, '$."type"') = 'text' ORDER BY rowid`;
  const rankedSql = `SELECT data FROM ${memTable} WHERE json_extract(data, '$."kind"') = ? AND json_type(data, '$."kind"') = 'text' AND json_extract(data, '$."state"') = ? AND json_type(data, '$."state"') = 'text' AND (json_extract(data, '$."product"') IN (?, ?, ?, ?) AND json_type(data, '$."product"') IN ('integer', 'real', 'text')) ORDER BY json_extract(data, '$."score"') DESC NULLS LAST, rowid LIMIT 90`;

  const oneLink: number[] = [];
  for (let i = 0; i < RUNS; i++) {
    const to = targets[i % targets.length]!;
    const started = performance.now();
    kv.list("links", { where: { to, type: "answers" } });
    oneLink.push(performance.now() - started);
  }
  out({ phase, statRows, query: "one-link", median_ms: median(oneLink), plan: plan(raw, oneLinkSql, [targets[0], "answers"]) });

  const ranked: number[] = [];
  let rows = 0;
  for (let i = 0; i < RUNS; i++) {
    const started = performance.now();
    rows = kv.listWhereIn("membership", "product", scope, {
      where: { kind: "problem", state: "open" }, sortBy: "score", sortDir: "desc", limit: 90,
    }).length;
    ranked.push(performance.now() - started);
  }
  out({ phase, statRows, query: "ranked", rows, median_ms: median(ranked), plan: plan(raw, rankedSql, ["problem", "open", ...scope]) });

  const write: number[] = [];
  for (let i = 0; i < RUNS; i++) {
    const started = performance.now();
    adapter.transaction(() => {
      for (let k = 0; k < 3; k++) {
        const to = targets[(i * 3 + k) % targets.length]!;
        for (const link of kv.list<{ from: string }>("links", { where: { to, type: "answers" } })) {
          kv.list("links", { where: { from: link.from, type: "serves" } });
        }
        kv.put("membership", { id: `w-${phase}-${i}-${k}`, product: "p40", record: to, kind: "problem", state: "open", score: i });
      }
    }, "immediate");
    write.push(performance.now() - started);
  }
  out({ phase, statRows, query: "write", median_ms: median(write), max_ms: +Math.max(...write).toFixed(3) });
  adapter.close();
}

measure("opened");

{
  const { adapter } = open();
  const refresh = (adapter as { refreshStatistics?: () => unknown }).refreshStatistics;
  if (refresh) {
    const started = performance.now();
    const report = refresh.call(adapter);
    out({ phase: "refreshStatistics", ms: +(performance.now() - started).toFixed(2), report });
  }
  adapter.close();
}

{
  const raw = new DatabaseSync(path);
  const started = performance.now();
  raw.exec("ANALYZE");
  out({ phase: "analyze", ms: Math.round(performance.now() - started) });
  raw.close();
}
measure("analyzed");

{
  const { adapter } = open();
  const started = performance.now();
  try {
    (adapter.kv.ensureIndex as (collection: string, fields: string | readonly string[]) => void)("membership", ["product", "kind", "state"]);
    out({ phase: "composite-index", ms: Math.round(performance.now() - started) });
  } catch (error) {
    out({ phase: "composite-index", error: String(error) });
  }
  adapter.close();
}
measure("composite");

rmSync(dir, { recursive: true, force: true });
