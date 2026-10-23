// What a write transaction does when the database fails under it: it rolls
// back, rejects with a typed error, leaves no half-applied write and no held
// lock, and raises no unhandled rejection.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createClient } from "@libsql/client";
import { AtomicMutationBackendError } from "@mirk/store/atomic";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { LibsqlAdapter } from "../libsql-adapter.js";
import { LibsqlAdapterError } from "../libsql-core.js";
import {
  dropTables,
  runPrefix,
  sqldBinary,
  sqldTarget,
  startSqld,
  tursoConnection,
  tursoTarget,
  type Adapter,
  type Sqld,
  type Target,
} from "./targets.js";

let unhandled: unknown[] = [];
const recordUnhandled = (reason: unknown) => unhandled.push(reason);
beforeEach(() => {
  unhandled = [];
  process.on("unhandledRejection", recordUnhandled);
});
afterEach(() => {
  process.off("unhandledRejection", recordUnhandled);
});

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 50));
}

describe("local file locked by another connection", () => {
  let directory: string;
  let url: string;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "mirk-libsql-busy-"));
    url = `file:${join(directory, "store.db")}`;
  });
  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it("fails with busy after busyTimeoutMs, then writes and nests normally once the lock is free", async () => {
    const adapter = await LibsqlAdapter.open({ url, busyTimeoutMs: 150 });
    const other = createClient({ url });
    try {
      await other.execute("BEGIN IMMEDIATE");
      const started = Date.now();
      const blocked = await adapter.kv.set("k", 1).catch((error: unknown) => error);
      expect(blocked).toBeInstanceOf(LibsqlAdapterError);
      expect((blocked as LibsqlAdapterError).code).toBe("busy");
      expect(Date.now() - started).toBeGreaterThanOrEqual(150);
      const atomic = await adapter.kv
        .mutateAtomically({ operations: [{ op: "set", key: "k", value: 2 }] })
        .catch((error: unknown) => error);
      expect(atomic).toBeInstanceOf(AtomicMutationBackendError);
      expect(atomic).toMatchObject({ code: "unavailable", retryable: true });
      await other.execute("COMMIT");

      expect(await adapter.kv.get("k")).toBeNull();
      await adapter.transaction(async () => {
        await adapter.kv.set("k", 3);
        await adapter.transaction(async () => {
          await adapter.kv.set("nested", true);
        });
      });
      expect(await adapter.kv.get("k")).toBe(3);
      expect(await adapter.kv.get("nested")).toBe(true);
      await settle();
      expect(unhandled).toEqual([]);
    } finally {
      other.close();
      adapter.close();
    }
  });

  it("waits for another connection's transaction to finish", async () => {
    const adapter = await LibsqlAdapter.open({ url, busyTimeoutMs: 5_000 });
    const other = createClient({ url });
    try {
      await other.execute("BEGIN IMMEDIATE");
      await other.execute({ sql: "INSERT INTO _kv (key, value) VALUES ('other', '1')", args: [] });
      setTimeout(() => void other.execute("COMMIT"), 100);
      await adapter.kv.set("mine", 2);
      expect(await adapter.kv.get("other")).toBe(1);
      expect(await adapter.kv.get("mine")).toBe(2);
    } finally {
      other.close();
      adapter.close();
    }
  });
});

describe.runIf(sqldBinary)("sqld killed mid-transaction", { timeout: 60_000 }, () => {
  let server: Sqld;
  beforeAll(async () => {
    server = await startSqld(sqldBinary!);
  });
  afterAll(async () => {
    await server?.stop();
  });

  it("rejects with connection-lost, keeps no partial write, and holds no lock after a restart", async () => {
    const database = await sqldTarget(() => server).fresh();
    try {
      const a = await database.open();
      await a.kv.set("before", 1);
      const transaction = a.transaction(async () => {
        await a.kv.set("partial", 1);
        await a.kv.put("records", { id: "r", state: "half" });
        await server.kill("SIGKILL");
        await a.kv.set("after-kill", 1);
      });
      const error = await transaction.catch((reason: unknown) => reason);
      expect(error).toBeInstanceOf(LibsqlAdapterError);
      expect((error as LibsqlAdapterError).code).toBe("connection-lost");
      expect(a.kv.set("while-down", 1)).rejects.toMatchObject({ code: "connection-lost" });
      await settle();

      await server.restart();
      expect(await a.kv.get("before")).toBe(1);
      expect(await a.kv.get("partial")).toBeNull();
      expect(await a.kv.getById("records", "r")).toBeNull();
      const b = await database.open({ busyTimeoutMs: 2_000 });
      await b.transaction(async () => {
        await b.kv.set("after-restart", true);
      });
      await a.kv.set("a-again", true);
      expect(await b.kv.get("a-again")).toBe(true);
      await settle();
      expect(unhandled).toEqual([]);
    } finally {
      await database.dispose();
    }
  });
});

function expiry(name: string, make: () => Target, holdMs: number): void {
  it(`${name}: a transaction held past the server's limit fails with transaction-expired and rolls back`, async () => {
    const database = await make().fresh();
    try {
      const a: Adapter = await database.open();
      const b: Adapter = await database.open();
      await a.kv.set("lease", "free");
      const held = a.transaction(async () => {
        await a.kv.set("lease", "a");
        await new Promise((resolve) => setTimeout(resolve, holdMs));
        await a.kv.set("a-after-hold", true);
      });
      await new Promise((resolve) => setTimeout(resolve, 200));
      const waiting = b.kv.set("lease", "b");
      const error = await held.catch((reason: unknown) => reason);
      await waiting;
      expect(error).toBeInstanceOf(LibsqlAdapterError);
      expect((error as LibsqlAdapterError).code).toBe("transaction-expired");
      expect(await b.kv.get("lease")).toBe("b");
      expect(await b.kv.get("a-after-hold")).toBeNull();
      await a.kv.set("a-recovers", true);
      expect(await b.kv.get("a-recovers")).toBe(true);
      await settle();
      expect(unhandled).toEqual([]);
    } finally {
      await database.dispose();
    }
  });
}

describe.runIf(sqldBinary)("sqld transaction expiry", { timeout: 60_000 }, () => {
  let server: Sqld;
  beforeAll(async () => {
    server = await startSqld(sqldBinary!);
  });
  afterAll(async () => {
    await server?.stop();
  });
  expiry("sqld", () => sqldTarget(() => server), 7_000);
});

describe.runIf(tursoConnection)("Turso transaction expiry", { timeout: 120_000 }, () => {
  afterAll(async () => {
    await dropTables(tursoConnection!, runPrefix);
  });
  expiry("Turso", tursoTarget, 14_000);
});
