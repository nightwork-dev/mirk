// Reads and failures that must stay consistent across two adapters: a
// versioned read of a row written before version tokens, a nested rollback
// that fails, and a rollback whose version-sequence commit fails.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createClient, type Client, type InStatement } from "@libsql/client";
import type { StoreVersion } from "@mirk/store";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { LibsqlAdapter } from "../libsql-adapter.js";
import { localWriterCount } from "../libsql-core.js";
import {
  fileTarget,
  sqldBinary,
  sqldTarget,
  startSqld,
  type Sqld,
  type Target,
} from "./targets.js";

const KEY = (key: string) => ({ kind: "key" as const, key });

function gate(): { wait: Promise<void>; open: () => void } {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => (open = resolve));
  return { wait, open };
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function consistency(make: () => Target): void {
  it("returns the value it versioned when another host writes during a lazy backfill", async () => {
    const database = await make().fresh();
    const raw = database.client();
    try {
      const a = await database.open();
      const b = await database.open();
      await a.kv.set("k", "A");
      // A row written before this adapter issued version tokens.
      await raw.execute(`DELETE FROM ${database.tablePrefix}_mirk_atomic_versions`);

      const written = gate();
      const release = gate();
      const writer = b.transaction(async () => {
        await b.kv.set("k", "B");
        written.open();
        await release.wait;
      });
      await written.wait;
      const read = a.kv.getVersioned(KEY("k"));
      await pause(100);
      release.open();
      await writer;

      const versioned = await read;
      const current = await b.kv.getVersioned(KEY("k"));
      expect(versioned).toEqual(current);
      const stale = await a.kv.mutateAtomically({
        conditions: [{ target: KEY("k"), expected: "version", version: versioned!.version }],
        operations: [{ op: "set", key: "k", value: "C" }],
      });
      expect(stale.status).toBe("applied");
      expect(await b.kv.get("k")).toBe("C");
    } finally {
      raw.close();
      await database.dispose();
    }
  });
}

describe("libSQL file: consistency", { timeout: 30_000 }, () => consistency(fileTarget));

describe.runIf(sqldBinary)("libSQL sqld consistency", { timeout: 60_000 }, () => {
  let server: Sqld;
  beforeAll(async () => {
    server = await startSqld(sqldBinary!);
  });
  afterAll(async () => {
    await server?.stop();
  });
  consistency(() => sqldTarget(() => server));

  it("keeps the inner error when its savepoint cannot be rolled back, and never commits the outer transaction", async () => {
    const database = await sqldTarget(() => server).fresh();
    try {
      const a = await database.open();
      let inner: unknown;
      const outer = await a
        .transaction(async () => {
          await a.kv.set("outer", 1);
          await a
            .transaction(async () => {
              await a.kv.set("inner", 1);
              await server.kill("SIGKILL");
              throw new Error("inner work failed");
            })
            .catch((error: unknown) => (inner = error));
        })
        .catch((error: unknown) => error);
      expect(inner).toBeInstanceOf(Error);
      expect((inner as Error).message).toBe("inner work failed");
      expect((inner as { rollbackError?: unknown }).rollbackError).toMatchObject({ code: "connection-lost" });
      expect(outer).toMatchObject({ code: "connection-lost" });

      await server.restart();
      const b = await database.open();
      expect(await b.kv.get("outer")).toBeNull();
      expect(await b.kv.get("inner")).toBeNull();
    } finally {
      await database.dispose();
    }
  });
});

/** A real client whose `execute` fails a statement `fails` picks with a lost
 *  connection, without running it. */
function faulty(real: Client, fails: (sql: string) => boolean): Client {
  return new Proxy(real, {
    get(target, property) {
      if (property === "execute") {
        return async (stmt: InStatement) => {
          const sql = typeof stmt === "string" ? stmt : stmt.sql;
          if (fails(sql)) throw Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
          return target.execute(stmt);
        };
      }
      const value = Reflect.get(target, property) as unknown;
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}

describe("local file failures under a nested or rolled-back transaction", () => {
  let directory: string;
  let url: string;
  beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), "mirk-libsql-consistency-"));
  });
  afterAll(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it("keeps the inner error when its savepoint cannot be rolled back, and never commits the outer transaction", async () => {
    url = `file:${join(directory, "nested.db")}`;
    const real = createClient({ url });
    let failRollbackTo = false;
    const client = faulty(real, (sql) => {
      if (failRollbackTo && sql.startsWith("ROLLBACK TO SAVEPOINT mirk_tx_")) {
        failRollbackTo = false;
        return true;
      }
      return false;
    });
    const a = await LibsqlAdapter.open({ url, client });
    try {
      let inner: unknown;
      const outer = await a
        .transaction(async () => {
          await a.kv.set("outer", 1);
          await a
            .transaction(async () => {
              await a.kv.set("inner", 1);
              failRollbackTo = true;
              throw new Error("inner work failed");
            })
            .catch((error: unknown) => (inner = error));
          // The inner write is still in the transaction: its rollback failed.
          expect(await a.kv.get("inner")).toBe(1);
        })
        .catch((error: unknown) => error);
      expect(inner).toBeInstanceOf(Error);
      expect((inner as Error).message).toBe("inner work failed");
      expect((inner as { rollbackError?: unknown }).rollbackError).toMatchObject({ code: "connection-lost" });
      expect(outer).toMatchObject({ code: "connection-lost" });
      expect(await a.kv.get("outer")).toBeNull();
      expect(await a.kv.get("inner")).toBeNull();
    } finally {
      a.close();
      real.close();
    }
  });

  it("forgets a file's writer lock when its last adapter closes", async () => {
    url = `file:${join(directory, "writers.db")}`;
    const before = localWriterCount();
    const a = await LibsqlAdapter.open({ url });
    const b = await LibsqlAdapter.open({ url });
    expect(localWriterCount()).toBe(before + 1);
    a.close();
    a.close();
    expect(localWriterCount()).toBe(before + 1);
    b.close();
    expect(localWriterCount()).toBe(before);
  });

  it("reports work that rolled back as not applied, and never reissues its tokens, when the sequence commit fails", async () => {
    url = `file:${join(directory, "counter.db")}`;
    const real = createClient({ url });
    let failNextCommit = false;
    const client = faulty(real, (sql) => {
      if (failNextCommit && sql === "COMMIT") {
        failNextCommit = false;
        return true;
      }
      return false;
    });
    const a = await LibsqlAdapter.open({ url, client });
    try {
      await a.kv.set("k", 0);
      let minted: StoreVersion | undefined;
      const failed = await a
        .transaction(async () => {
          await a.kv.set("k", 1);
          minted = (await a.kv.getVersioned(KEY("k")))!.version;
          failNextCommit = true;
          throw new Error("work failed");
        })
        .catch((error: unknown) => error);
      expect((failed as Error).message).toBe("work failed");
      expect(await a.kv.get("k")).toBe(0);

      await a.kv.set("k", 2);
      expect((await a.kv.getVersioned(KEY("k")))!.version).not.toBe(minted);
      const stale = await a.kv.mutateAtomically({
        conditions: [{ target: KEY("k"), expected: "version", version: minted! }],
        operations: [{ op: "set", key: "k", value: 3 }],
      });
      expect(stale.status).toBe("conflict");
    } finally {
      a.close();
      real.close();
    }
  });
});
