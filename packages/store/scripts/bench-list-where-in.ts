// Times Foreclose-shaped reads on a SQLite collection shaped like a large
// per-record domain store: 120,000 `sightings`, each naming one of 1,200
// captures and one of 400 source records. It prints timings; it asserts nothing.
//
//   pnpm --filter @mirk/store exec tsx scripts/bench-list-where-in.ts [--index]
//
// `--index` declares the queried fields with `ensureIndex` before loading, to
// show what an expression index on each adds.
import BetterSqliteDatabase from "better-sqlite3";

import { SqliteAdapter } from "../src/adapters/sqlite.js";
import type { StoreFilter } from "../src/types.js";

const RECORDS = 120_000;
const CAPTURES = 1_200;
const SOURCES = 400;
const RUNS = 5;

interface Sighting {
  id: string;
  sourceRecordId: string;
  captureId: string;
  propertyId: string;
  observedAt: string;
  price: number;
  status: string;
  notes: string;
}

function sighting(index: number): Sighting {
  return {
    id: `sighting-${index}`,
    sourceRecordId: `source-${index % SOURCES}`,
    captureId: `capture-${(index * 7919) % CAPTURES}`,
    propertyId: `property-${index % 2_000}`,
    observedAt: new Date(Date.UTC(2026, 0, 1) + index * 60_000).toISOString(),
    price: 100_000 + (index % 977) * 250,
    status: index % 3 === 0 ? "active" : "pending",
    notes: `Listing observed on pass ${index % 31}; seller notes unchanged.`,
  };
}

function median(samples: number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

const db = new BetterSqliteDatabase(":memory:");
const adapter = new SqliteAdapter({ path: ":memory:", db });
const store = adapter.kv;

if (process.argv.includes("--index")) {
  for (const field of ["captureId", "sourceRecordId", "observedAt"]) store.ensureIndex("sightings", field);
  console.log("declared indexes on captureId, sourceRecordId and observedAt");
}

const loadStart = performance.now();
db.transaction(() => {
  for (let index = 0; index < RECORDS; index++) store.put("sightings", sighting(index));
})();
console.log(`loaded ${RECORDS} sightings in ${(performance.now() - loadStart).toFixed(0)} ms`);

function time(label: string, read: () => unknown[] | number): void {
  read();
  const samples: number[] = [];
  let result: unknown[] | number = 0;
  for (let run = 0; run < RUNS; run++) {
    const start = performance.now();
    result = read();
    samples.push(performance.now() - start);
  }
  const size = typeof result === "number" ? `count ${result}` : `${result.length} rows`;
  console.log(
    `${label}: ${size}, median ${median(samples).toFixed(1)} ms (runs: ${samples.map((s) => s.toFixed(0)).join(", ")})`,
  );
}

const cases: { field: keyof Sighting; values: string[] }[] = [
  { field: "captureId", values: Array.from({ length: 50 }, (_, i) => `capture-${i * 13}`) },
  { field: "captureId", values: Array.from({ length: 500 }, (_, i) => `capture-${i * 2}`) },
  { field: "sourceRecordId", values: Array.from({ length: 50 }, (_, i) => `source-${i * 7}`) },
];
for (const { field, values } of cases) {
  time(`listWhereIn ${field} x${values.length}`, () => store.listWhereIn("sightings", field, values));
}

// The last 1,200 sightings, as a "changed since" sync would ask for them.
const since = sighting(RECORDS - 1_200).observedAt;
const filters: [string, StoreFilter][] = [
  ["list where sourceRecordId", { where: { sourceRecordId: "source-7" } }],
  ["list where observedAt >= since", { where: { observedAt: { gte: since } } }],
  ["list sortBy observedAt desc, limit 50", { sortBy: "observedAt", sortDir: "desc", limit: 50 }],
];
for (const [label, filter] of filters) time(label, () => store.list("sightings", filter));
time("count where observedAt >= since", () => store.count("sightings", { where: { observedAt: { gte: since } } }));

adapter.close();
