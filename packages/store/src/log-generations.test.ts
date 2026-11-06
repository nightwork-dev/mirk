import { DatabaseSync } from "node:sqlite";
import { InMemoryKv } from "./kv.js";
import { createMemoryTransactions } from "./transaction.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { NodeSqliteAdapter } from "./adapters/node-sqlite.js";
import { SqliteAdapter } from "./adapters/sqlite.js";
import { InMemoryLogStore, type LogStore, type LogCursor, toAsyncLog } from "./log.js";

const roots: string[] = [];
function file() { const root = mkdtempSync(join(tmpdir(), "mirk-log-generation-")); roots.push(root); return join(root, "log.db"); }
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const backends: [string, () => { log: LogStore; transaction<T>(work: () => T): T; close(): void }][] = [
  ["memory", () => { const log = new InMemoryLogStore(); return { log, transaction: work => log.transaction(work), close() {} }; }],
  ["better-sqlite3", () => new SqliteAdapter({ path: file() })],
  ["node:sqlite", () => new NodeSqliteAdapter({ path: file() })],
];

describe.each(backends)("log cursor generations (%s)", (_name, open) => {
  it("paginates one incarnation and refuses deleted/recreated or missing-stream cursors", () => {
    const db = open();
    try {
      expect(db.log.lastCursor("s")).toBeNull();
      expect(db.log.list("s")).toEqual([]);
      db.log.append("s", "one"); db.log.append("s", "two"); db.log.append("s", "three");
      const first = db.log.list("s", { limit: 1 })[0]!;
      expect(first).toEqual({ generation: 1, sequence: 1, record: "one" });
      expect(db.log.list("s", { after: first, limit: 1 })).toEqual([{ generation: 1, sequence: 2, record: "two" }]);
      expect(db.log.lastCursor("s")).toEqual({ generation: 1, sequence: 3 });
      db.log.append("other", "independent");
      expect(db.log.lastCursor("other")?.generation).toBe(2);
      expect(() => db.log.list("other", { after: first })).toThrow("missing or replaced");
      expect(db.log.deleteStream("s")).toBe(true);
      expect(() => db.log.list("s", { after: first, limit: 0 })).toThrow("missing or replaced");
      expect(db.log.append("s", "replacement")).toBe(1);
      expect(db.log.lastCursor("s")).toEqual({ generation: 3, sequence: 1 });
      expect(() => db.log.list("s", { after: first })).toThrow("missing or replaced");
      expect(() => db.log.list("absent", { after: first })).toThrow("missing or replaced");
      expect(() => db.log.list("s", { after: 1 as unknown as LogCursor })).toThrow("must be a cursor");
    } finally { db.close(); }
  });
  it("restores the complete incarnation after delete-append rollback", () => {
    const db = open();
    try {
      db.log.append("s", "one");
      const cursor = db.log.lastCursor("s")!;
      expect(() => db.transaction(() => {
        db.log.deleteStream("s"); db.log.append("s", "replacement"); db.log.append("new", "uncommitted");
        expect(db.log.lastCursor("s")!.generation).toBeGreaterThan(cursor.generation);
        throw new Error("abort");
      })).toThrow("abort");
      expect(db.log.lastCursor("s")).toEqual(cursor);
      expect(db.log.list("s", { after: { ...cursor, sequence: 0 } })).toEqual([{ ...cursor, record: "one" }]);
      expect(db.log.lastCursor("new")).toBeNull();
      db.log.deleteStream("s"); db.log.append("s", "committed replacement");
      expect(() => db.log.list("s", { after: cursor })).toThrow("missing or replaced");
    } finally { db.close(); }
  });
});

it("lifts lastCursor and stale-cursor errors through the existing async bridge", async () => {
  const log = new InMemoryLogStore(); const asyncLog = toAsyncLog(log);
  await asyncLog.append("s", "one"); const cursor = (await asyncLog.lastCursor("s"))!;
  await asyncLog.deleteStream("s"); await asyncLog.append("s", "new");
  await expect(asyncLog.list("s", { after: cursor })).rejects.toMatchObject({ code: "stale-cursor" });
});

it("a real competing SQLite process cannot return replacement entries for an old cursor", async () => {
  const path = file(); const reader = new NodeSqliteAdapter({ path });
  reader.log.append("s", "original"); const cursor = reader.log.lastCursor("s")!;
  const module = pathToFileURL(join(import.meta.dirname, "../dist/adapters/node-sqlite.js")).href;
  const writer = spawn(process.execPath, ["--input-type=module", "-e", `import {NodeSqliteAdapter} from ${JSON.stringify(module)}; const db=new NodeSqliteAdapter({path:process.argv[1]}); process.stdout.write('ready\\n'); for(let n=0;n<100;n++){db.transaction(()=>{db.log.deleteStream('s');db.log.append('s','replacement-'+n)},'immediate')} db.close();`, path], { stdio: ["ignore", "pipe", "pipe"] });
  let errors = ""; writer.stderr.on("data", data => { errors += String(data); });
  const exited = new Promise<number | null>((resolve, reject) => { writer.on("error", reject); writer.on("exit", resolve); });
  await new Promise<void>(resolve => writer.stdout.once("data", () => resolve()));
  try {
    for (let index = 0; index < 100; index++) {
      try { expect(reader.log.list("s", { after: { ...cursor, sequence: 0 } }).map(entry => entry.record)).toEqual(["original"]); }
      catch (error) { if ((error as { code?: string }).code !== "stale-cursor") throw error; }
      await new Promise(resolve => setImmediate(resolve));
    }
    expect(await exited, errors).toBe(0);
    expect(() => reader.log.list("s", { after: cursor })).toThrow("missing or replaced");
  } finally { writer.kill(); reader.close(); }
});

it("shared memory savepoints restore the stream epoch and allocation counter", async () => {
  const kv = new InMemoryKv(); const log = new InMemoryLogStore();
  const tx = createMemoryTransactions({ kv, log });
  log.append("s", "original"); const cursor = log.lastCursor("s")!;
  await expect(tx.transaction(async () => {
    kv.set("outer", true);
    await expect(tx.transaction(() => {
      log.deleteStream("s"); log.append("s", "inner replacement"); log.append("inner", "temporary");
      throw new Error("inner");
    })).rejects.toThrow("inner");
    expect(log.lastCursor("s")).toEqual(cursor);
    expect(log.lastCursor("inner")).toBeNull();
    log.append("outer-new", "temporary");
    throw new Error("outer");
  })).rejects.toThrow("outer");
  expect(kv.has("outer")).toBe(false);
  expect(log.lastCursor("s")).toEqual(cursor);
  expect(log.lastCursor("outer-new")).toBeNull();
  log.append("after", "committed");
  expect(log.lastCursor("after")!.generation).toBe(2);
});

it("refuses exhausted generation allocation without wrapping or leaving a live stream", () => {
  const raw = new DatabaseSync(":memory:");
  const db = new NodeSqliteAdapter({ path: ":memory:", db: raw });
  try {
    db.log.append("existing", "one");
    raw.exec("UPDATE _mirk_log_generation SET value = 9007199254740991 WHERE id = 1");
    expect(() => db.log.append("new", "refused")).toThrow("generation counter exhausted");
    expect(db.log.lastCursor("new")).toBeNull();
    expect(db.log.append("existing", "two")).toBe(2);
    expect(raw.prepare("SELECT COUNT(*) AS n FROM _mirk_log_streams").get()).toEqual({ n: 1 });
  } finally { db.close(); raw.close(); }
});
