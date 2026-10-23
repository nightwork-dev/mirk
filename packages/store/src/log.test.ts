import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { NodeSqliteAdapter } from "./adapters/node-sqlite.js";
import { SqliteAdapter } from "./adapters/sqlite.js";
import { InMemoryLogStore, LogInputError, toAsyncLog } from "./log.js";
import type { JsonValue, LogStore } from "./log.js";

const adapters = [
  ["better-sqlite3", SqliteAdapter],
  ["node:sqlite", NodeSqliteAdapter],
] as const;

const dirs: string[] = [];
function tempFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "mirk-log-"));
  dirs.push(dir);
  return join(dir, "log.sqlite");
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Every sequence from 1 to lastSequence has exactly its record, in order. */
function expectContiguous(log: LogStore, stream: string): void {
  const last = log.lastSequence(stream);
  const entries = log.list(stream);
  expect(entries.map((entry) => entry.sequence)).toEqual(
    Array.from({ length: last }, (_, index) => index + 1)
  );
  for (const entry of entries) expect(log.get(stream, entry.sequence)).toEqual(entry);
}

describe("log records follow the strict JSON rules", () => {
  const stores: [string, () => { log: LogStore; close(): void }][] = [
    ["memory", () => ({ log: new InMemoryLogStore(), close: () => {} })],
    ...adapters.map(
      ([name, Adapter]) =>
        [
          name,
          () => {
            const adapter = new Adapter({ path: ":memory:" });
            return { log: adapter.log, close: () => adapter.close() };
          },
        ] as [string, () => { log: LogStore; close(): void }]
    ),
  ];
  for (const [name, open] of stores) {
    it(`${name}: refuses a record JSON cannot carry and consumes no sequence`, () => {
      const { log, close } = open();
      try {
        log.append("s", { ok: 1 });
        for (const bad of [Number.NaN, undefined, { at: new Date(0) }, [1, , 3]]) {
          expect(() => log.append("s", bad as never)).toThrow(LogInputError);
        }
        expect(() => log.append("s", Number.POSITIVE_INFINITY as never)).toThrow(
          "log record is not JSON-safe: non-finite numbers are not JSON-safe"
        );
        expect(log.append("s", { ok: 2 })).toBe(2);
        expectContiguous(log, "s");
      } finally {
        close();
      }
    });
  }
});

describe.each(adapters)("SQLite log facet (%s)", (_name, Adapter) => {
  it("a failed record write consumes no sequence: no number is left without its record", () => {
    const adapter = new Adapter({ path: ":memory:" });
    try {
      // Fail the record write itself, after any bookkeeping an implementation
      // does before it, the way a crash between two writes would.
      adapter.transaction(() => {
        (adapter as unknown as { db: { exec(sql: string): void } }).db.exec(
          `CREATE TRIGGER fail_record BEFORE INSERT ON _mirk_log
           WHEN NEW.record = '"boom"'
           BEGIN SELECT RAISE(ABORT, 'injected record failure'); END`
        );
      });
      expect(adapter.log.append("s", "a")).toBe(1);
      expect(() => adapter.log.append("s", "boom")).toThrow("injected record failure");
      expect(adapter.log.lastSequence("s")).toBe(1);
      expect(adapter.log.append("s", "b")).toBe(2);
      expect(adapter.log.get("s", 2)).toEqual({ sequence: 2, record: "b" });
      expectContiguous(adapter.log, "s");
    } finally {
      adapter.close();
    }
  });

  it("an append inside transaction() rolls back with it, and its sequence is reused", () => {
    const adapter = new Adapter({ path: ":memory:" });
    try {
      adapter.log.append("s", "first");
      let rolledBack = 0;
      expect(() =>
        adapter.transaction(() => {
          adapter.kv.set("k", 1);
          rolledBack = adapter.log.append("s", "rolled back");
          throw new Error("abort");
        })
      ).toThrow("abort");
      expect(rolledBack).toBe(2);
      expect(adapter.kv.get("k")).toBeNull();
      expect(adapter.log.lastSequence("s")).toBe(1);
      expect(adapter.log.append("s", "second")).toBe(2);
      expect(adapter.log.list("s").map((entry) => entry.record)).toEqual(["first", "second"]);
    } finally {
      adapter.close();
    }
  });

  it("asyncLog joins asyncTransaction and rolls back with it", async () => {
    const adapter = new Adapter({ path: tempFile() });
    try {
      await adapter.asyncLog.append("s", "first");
      await expect(
        adapter.asyncTransaction(async () => {
          expect(await adapter.asyncLog.append("s", "rolled back")).toBe(2);
          await adapter.asyncKv.set("k", 1);
          throw new Error("abort");
        })
      ).rejects.toThrow("abort");
      expect(await adapter.asyncLog.lastSequence("s")).toBe(1);
      await adapter.asyncTransaction(async () => {
        expect(await adapter.asyncLog.append("s", "second")).toBe(2);
      });
      expect(await adapter.asyncLog.list("s", { after: 1 })).toEqual([
        { sequence: 2, record: "second" },
      ]);
    } finally {
      adapter.close();
    }
  });

  it("two connections appending to one file interleave without a gap or a duplicate", () => {
    const path = tempFile();
    const first = new Adapter({ path });
    const second = new Adapter({ path });
    try {
      const given: number[] = [];
      for (let index = 0; index < 50; index += 1) {
        given.push((index % 2 === 0 ? first : second).log.append("s", index));
      }
      expect(given).toEqual(Array.from({ length: 50 }, (_, index) => index + 1));
      expectContiguous(first.log, "s");
      expect(second.log.list("s").map((entry) => entry.record)).toEqual(
        Array.from({ length: 50 }, (_, index) => index)
      );
    } finally {
      first.close();
      second.close();
    }
  });

  it("persists across reopen and continues the sequence", () => {
    const path = tempFile();
    const writer = new Adapter({ path });
    writer.log.append("events", { kind: "submitted" });
    writer.log.append("events", { kind: "settled" });
    writer.close();
    const reader = new Adapter({ path });
    try {
      expect(reader.log.lastSequence("events")).toBe(2);
      expect(reader.log.append("events", { kind: "submitted" })).toBe(3);
      expectContiguous(reader.log, "events");
    } finally {
      reader.close();
    }
  });
});

describe("append typing", () => {
  it("accepts a JsonValue and a caller's own JSON-shaped interface without a cast", async () => {
    interface Settled {
      kind: "settled";
      deliveryId: string;
      outcome: "done" | "failed";
      threadId?: string;
    }
    const event: Settled = { kind: "settled", deliveryId: "d1", outcome: "done" };
    const value: JsonValue = JSON.parse('{"a":[1,null]}') as JsonValue;
    const log = new InMemoryLogStore();
    expect(log.append("s", event)).toBe(1);
    expect(log.append("s", value)).toBe(2);
    expect(await toAsyncLog(log).append("s", event)).toBe(3);
    // @ts-expect-error a function is not JSON
    expect(() => log.append("s", { run: () => 1 })).toThrow(LogInputError);
    expect(log.get<Settled>("s", 1)?.record.outcome).toBe("done");
  });
});

describe("InMemoryLogStore.transaction", () => {
  it("undoes appends when the work throws, so the sequence is reused", () => {
    const log = new InMemoryLogStore();
    log.append("s", "first");
    expect(() =>
      log.transaction(() => {
        expect(log.append("s", "rolled back")).toBe(2);
        expect(log.append("new", "rolled back")).toBe(1);
        throw new Error("abort");
      })
    ).toThrow("abort");
    expect(log.lastSequence("s")).toBe(1);
    expect(log.lastSequence("new")).toBe(0);
    expect(log.append("s", "second")).toBe(2);
    expectContiguous(log, "s");
  });

  it("keeps appends when the work returns", async () => {
    const log = new InMemoryLogStore();
    expect(log.transaction(() => log.append("s", "kept"))).toBe(1);
    expect(await toAsyncLog(log).list("s")).toEqual([{ sequence: 1, record: "kept" }]);
  });
});
