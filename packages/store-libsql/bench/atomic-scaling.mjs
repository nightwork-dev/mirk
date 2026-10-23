// Times `kv.mutateAtomically` with 1, 10 and 100 puts against a libSQL server
// and counts the requests each one sends. Run `pnpm build` first.
//
//   MIRK_BENCH_URL=http://127.0.0.1:8080 node packages/store-libsql/bench/atomic-scaling.mjs
//
// MIRK_BENCH_TOKEN carries an auth token for a hosted database. Every run uses
// its own table prefix and drops its tables at the end.
//
// MIRK_BENCH_DELAY_MS adds a fixed delay to every request, to show what a
// network round trip of that length costs against a loopback server.
//
// "cold" writes into a collection the adapter has not seen; "warm" writes into
// one it already uses. Each size runs MIRK_BENCH_REPEATS times (default 3); the
// table reports the median.

import { randomUUID } from "node:crypto";

import { createClient } from "@libsql/client/web";

import { LibsqlAdapter } from "../dist/remote.js";

const url = process.env.MIRK_BENCH_URL;
if (!url) throw new Error("Set MIRK_BENCH_URL to a libSQL server URL.");
const authToken = process.env.MIRK_BENCH_TOKEN;
const connection = authToken ? { url, authToken } : { url };
const repeats = Number(process.env.MIRK_BENCH_REPEATS ?? 3);
const delayMs = Number(process.env.MIRK_BENCH_DELAY_MS ?? 0);
const delay = () => (delayMs > 0 ? new Promise((resolve) => setTimeout(resolve, delayMs)) : Promise.resolve());
const sizes = [1, 10, 100];
const tablePrefix = `mirk_bench_${randomUUID().replaceAll("-", "").slice(0, 10)}_`;

/** Wraps a client so every request it sends is counted. */
function counting(client) {
  const counts = { requests: 0, statements: 0 };
  const count = (statements, send) => {
    counts.requests += 1;
    counts.statements += statements;
    return delay().then(send);
  };
  const wrapTransaction = (tx) => new Proxy(tx, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (prop === "execute") return (stmt) => count(1, () => value.call(target, stmt));
      if (prop === "batch") return (stmts) => count(stmts.length, () => value.call(target, stmts));
      if (prop === "commit" || prop === "rollback") return () => count(1, () => value.call(target));
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const wrapped = new Proxy(client, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (prop === "execute") return (stmt) => count(1, () => value.call(target, stmt));
      if (prop === "batch") return (stmts, mode) => count(stmts.length, () => value.call(target, stmts, mode));
      if (prop === "transaction") return async (mode) => wrapTransaction(await value.call(target, mode));
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { client: wrapped, counts };
}

function puts(collection, n, run) {
  return Array.from({ length: n }, (_, i) => ({
    op: "put",
    collection,
    item: { id: `r${run}-${i}`, value: i, padding: "x".repeat(64) },
  }));
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

async function measure(adapter, counts, operations) {
  const before = { ...counts };
  const started = performance.now();
  const result = await adapter.kv.mutateAtomically({ operations });
  const ms = performance.now() - started;
  if (result.status !== "applied") throw new Error(`unexpected status ${result.status}`);
  return { ms, requests: counts.requests - before.requests, statements: counts.statements - before.statements };
}

const raw = createClient(connection);
const { client, counts } = counting(raw);
const adapter = await LibsqlAdapter.open({ url, client, tablePrefix });
const rows = [];
try {
  let run = 0;
  for (const mode of ["cold", "warm"]) {
    for (const n of sizes) {
      const samples = [];
      for (let r = 0; r < repeats; r++) {
        run += 1;
        const collection = mode === "cold" ? `cold_${run}` : "warm";
        if (mode === "warm") await adapter.kv.put(collection, { id: "seed" });
        samples.push(await measure(adapter, counts, puts(collection, n, run)));
      }
      rows.push({
        mode,
        puts: n,
        "median ms": Math.round(median(samples.map((s) => s.ms))),
        requests: median(samples.map((s) => s.requests)),
        statements: median(samples.map((s) => s.statements)),
      });
    }
  }
} finally {
  adapter.close();
  const dropper = createClient(connection);
  try {
    for (let pass = 0; pass < 5; pass++) {
      const rs = await dropper.execute({
        sql: "SELECT name FROM sqlite_master WHERE type = 'table' AND substr(name, 1, length(?)) = ?",
        args: [tablePrefix, tablePrefix],
      });
      if (rs.rows.length === 0) break;
      for (const row of rs.rows) {
        await dropper.execute(`DROP TABLE IF EXISTS "${String(row.name)}"`).catch(() => undefined);
      }
    }
  } finally {
    dropper.close();
    raw.close();
  }
}
console.table(rows);
