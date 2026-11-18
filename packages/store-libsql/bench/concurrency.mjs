// Measures how one slow query affects other reads, for the built-in Node
// SQLite adapter and the libSQL file adapter, in one process and across
// processes. Run `pnpm build` first.
//
//   node packages/store-libsql/bench/concurrency.mjs [records]
//
// The store holds `items` records ({ id, group, tag, n, body }); `group` is
// indexed, `tag` is not. A fast read is `getById`. A slow read is a `where` on
// the unindexed `tag`, which scans the table. A write is one transaction of
// 100 puts. Every scenario prints one JSON line: fast reads done, their median,
// 99th percentile and worst wait in milliseconds (the wait counts from when the
// read was due, so it includes time spent behind other work on the thread),
// and slow reads and writes done.
//
// Scenarios:
//   one-process     fast reads due every 2 ms and a slow read every 400 ms, on
//                   one adapter in one thread.
//   worker-thread   the same fast reads on the main thread; the slow reads run
//                   on their own adapter in a worker thread.
//   processes       4 reader processes reading as fast as they can, 1 process
//                   running slow reads, 1 process writing, on one file.

import { fork } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";

import { NodeSqliteAdapter } from "@mirk/store/node-sqlite";

import { LibsqlAdapter } from "../dist/index.js";

const self = fileURLToPath(import.meta.url);
const SECONDS = 4;
const KINDS = (process.env.MIRK_BENCH_KINDS ?? "node-sqlite,libsql").split(",");
const refreshStatisticsAfterChanges = process.env.MIRK_BENCH_REFRESH === undefined ? undefined : Number(process.env.MIRK_BENCH_REFRESH);

async function openStore(kind, path) {
  if (kind === "node-sqlite") {
    const adapter = new NodeSqliteAdapter({ path, refreshStatisticsAfterChanges });
    return {
      get: async (id) => adapter.kv.getById("items", id),
      slow: async (tag) => adapter.kv.list("items", { where: { tag } }).length,
      write: async (batch) => adapter.transaction(() => { for (const item of batch) adapter.kv.put("items", item); }, "immediate"),
      load: async (items) => adapter.transaction(() => { for (const item of items) adapter.kv.put("items", item); }, "immediate"),
      index: async () => adapter.kv.ensureIndex("items", "group"),
      close: () => adapter.close(),
    };
  }
  const adapter = await LibsqlAdapter.open({ url: `file:${path}`, refreshStatisticsAfterChanges });
  return {
    get: (id) => adapter.kv.getById("items", id),
    slow: async (tag) => (await adapter.kv.list("items", { where: { tag } })).length,
    write: (batch) => adapter.transaction(async () => { for (const item of batch) await adapter.kv.put("items", item); }),
    load: (items) => adapter.transaction(async () => { for (const item of items) await adapter.kv.put("items", item); }),
    index: () => adapter.kv.ensureIndex("items", "group"),
    close: () => adapter.close(),
  };
}

const item = (i) => ({ id: `i${i}`, group: `g${i % 1000}`, tag: `t${i % 50_000}`, n: i, body: "x".repeat(160) });

function summary(waits) {
  const sorted = [...waits].sort((a, b) => a - b);
  const at = (q) => +(sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0).toFixed(2);
  return { fastReads: sorted.length, medianMs: at(0.5), p99Ms: at(0.99), worstMs: at(1) };
}

/** Fast reads due every 2 ms for SECONDS; wait = finish time minus due time. */
async function paceFastReads(store, records, extra) {
  const waits = [];
  const started = performance.now();
  let next = started;
  let i = 0;
  await new Promise((resolve) => {
    const tick = async () => {
      const now = performance.now();
      if (now - started > SECONDS * 1000) return resolve();
      while (next <= now) {
        const due = next;
        next += 2;
        await store.get(`i${(i++ * 7919) % records}`);
        waits.push(performance.now() - due);
      }
      setTimeout(tick, Math.max(0, next - performance.now()));
    };
    extra?.();
    tick();
  });
  return summary(waits);
}

async function runChild(role, kind, path, records) {
  const store = await openStore(kind, path);
  const end = performance.now() + SECONDS * 1000;
  const waits = [];
  const failures = new Map();
  let count = 0;
  while (performance.now() < end) {
    const started = performance.now();
    try {
      if (role === "reader") await store.get(`i${(count * 7919) % records}`);
      else if (role === "slow") await store.slow(`t${count % 50_000}`);
      else await store.write(Array.from({ length: 100 }, (_, j) => item(records + count * 100 + j)));
    } catch (error) {
      const code = error.code ?? error.message;
      failures.set(code, (failures.get(code) ?? 0) + 1);
    }
    waits.push(performance.now() - started);
    count++;
    if (role === "reader" && count % 64 === 0) await new Promise((resolve) => setImmediate(resolve));
  }
  store.close();
  return { role, done: count, failures: Object.fromEntries(failures), ...summary(waits) };
}

if (!isMainThread) {
  const { kind, path } = workerData;
  const store = await openStore(kind, path);
  let slowReads = 0;
  const failures = new Map();
  let stop = false;
  parentPort.on("message", () => { stop = true; });
  while (!stop) {
    try {
      await store.slow(`t${slowReads % 50_000}`);
    } catch (error) {
      failures.set(error.code ?? error.message, (failures.get(error.code ?? error.message) ?? 0) + 1);
    }
    slowReads++;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  store.close();
  parentPort.postMessage({ slowReads, failures: Object.fromEntries(failures) });
} else if (process.argv[2] === "--child") {
  const [, , , role, kind, path, records] = process.argv;
  process.send(await runChild(role, kind, path, Number(records)));
  process.exit(0);
} else {
  const records = Number(process.argv[2] ?? 300_000);
  const dir = mkdtempSync(join(tmpdir(), "mirk-bench-concurrency-"));
  try {
    for (const kind of KINDS) {
      const path = join(dir, `${kind}.db`);
      {
        const store = await openStore(kind, path);
        await store.index();
        for (let i = 0; i < records; i += 10_000) await store.load(Array.from({ length: Math.min(10_000, records - i) }, (_, j) => item(i + j)));
        for (let i = 0; i < 2_000; i++) await store.get(`i${(i * 7919) % records}`);
        const started = performance.now();
        await store.slow("t1");
        console.log(JSON.stringify({ kind, records, slowReadMs: +(performance.now() - started).toFixed(1) }));
        const quiet = await paceFastReads(store, records);
        console.log(JSON.stringify({ kind, scenario: "fast reads alone", ...quiet }));
        let slowReads = 0;
        let stop = false;
        const busy = await paceFastReads(store, records, async () => {
          while (!stop) {
            await new Promise((resolve) => setTimeout(resolve, 400));
            if (stop) break;
            await store.slow(`t${slowReads++}`);
          }
        });
        stop = true;
        console.log(JSON.stringify({ kind, scenario: "one-process", slowReads, ...busy }));
        store.close();
      }
      {
        const store = await openStore(kind, path);
        const worker = new Worker(self, { workerData: { kind, path } });
        await new Promise((resolve) => setTimeout(resolve, 200));
        const result = await paceFastReads(store, records);
        worker.postMessage("stop");
        const { slowReads, failures } = await new Promise((resolve) => worker.once("message", resolve));
        await worker.terminate();
        console.log(JSON.stringify({ kind, scenario: "worker-thread", slowReads, slowReadFailures: failures, ...result }));
        store.close();
      }
      {
        const roles = ["reader", "reader", "reader", "reader", "slow", "writer"];
        const results = await Promise.all(roles.map((role) => new Promise((resolve, reject) => {
          const child = fork(self, ["--child", role, kind, path, String(records)]);
          child.once("message", resolve);
          child.once("error", reject);
        })));
        const readers = results.filter((r) => r.role === "reader");
        console.log(JSON.stringify({
          kind,
          scenario: "processes",
          readsPerSecond: Math.round(readers.reduce((sum, r) => sum + r.done, 0) / SECONDS),
          readerP99Ms: Math.max(...readers.map((r) => r.p99Ms)),
          readerWorstMs: Math.max(...readers.map((r) => r.worstMs)),
          readerFailures: readers.map((r) => r.failures),
          slow: results.find((r) => r.role === "slow"),
          writer: results.find((r) => r.role === "writer"),
        }));
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
