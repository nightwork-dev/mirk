// Times `listWhereIn` on a SQLite collection shaped like a large per-record
// domain store: 120,000 `sightings`, each naming one of 1,200 captures and one
// of 400 source records. It prints timings; it asserts nothing.
//
//   pnpm --filter @mirk/store exec tsx scripts/bench-list-where-in.ts [--index]
//
// `--index` also creates expression indexes on the two queried fields directly
// in the physical table, to show what an index on the same expression adds.
import BetterSqliteDatabase from "better-sqlite3";

import { SqliteAdapter } from "../src/adapters/sqlite.js";
import { jsonPath } from "../src/sql.js";

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

const loadStart = performance.now();
db.transaction(() => {
  for (let index = 0; index < RECORDS; index++) store.put("sightings", sighting(index));
})();
console.log(`loaded ${RECORDS} sightings in ${(performance.now() - loadStart).toFixed(0)} ms`);

if (process.argv.includes("--index")) {
  const table = (
    db.prepare("SELECT table_name FROM _mirk_tables WHERE kind = 'collection' AND name = ?").get("sightings") as {
      table_name: string;
    }
  ).table_name;
  for (const field of ["captureId", "sourceRecordId"]) {
    const path = jsonPath(field).replace(/'/g, "''");
    db.exec(`CREATE INDEX bench_${field} ON ${table} (json_extract(data, '${path}'))`);
  }
  db.exec("ANALYZE");
  console.log("created expression indexes on captureId and sourceRecordId");
}

const cases: { field: keyof Sighting; values: string[] }[] = [
  { field: "captureId", values: Array.from({ length: 50 }, (_, i) => `capture-${i * 13}`) },
  { field: "captureId", values: Array.from({ length: 500 }, (_, i) => `capture-${i * 2}`) },
  { field: "sourceRecordId", values: Array.from({ length: 50 }, (_, i) => `source-${i * 7}`) },
];

for (const { field, values } of cases) {
  store.listWhereIn("sightings", field, values);
  const samples: number[] = [];
  let rows = 0;
  for (let run = 0; run < RUNS; run++) {
    const start = performance.now();
    rows = store.listWhereIn("sightings", field, values).length;
    samples.push(performance.now() - start);
  }
  console.log(
    `listWhereIn ${field} x${values.length}: ${rows} rows, median ${median(samples).toFixed(1)} ms (runs: ${samples.map((s) => s.toFixed(0)).join(", ")})`,
  );
}

adapter.close();
