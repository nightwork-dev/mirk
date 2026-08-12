import { describe, expect, it } from "vitest";
import { beforeAll } from "vitest";
import { execFileSync, fork } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  AtomicMutationRejectedError,
  canonicalJson,
  InMemoryKv,
  namespaceStore,
  supportsAtomicMutation,
} from "./index.js";
import { SqliteAdapter } from "./adapters/sqlite.js";
import type {
  SyncAtomicMutationStore,
  SyncStore,
  StoreCondition,
  StoreTarget,
} from "./index.js";

type AtomicStore = SyncStore & SyncAtomicMutationStore;

function atomic(store: SyncStore): AtomicStore {
  if (!supportsAtomicMutation(store))
    throw new Error("test store lacks atomic capability");
  return store;
}

function stores(): Array<
  [string, () => { store: AtomicStore; close?: () => void }]
> {
  return [
    ["memory", () => ({ store: atomic(new InMemoryKv()) })],
    [
      "sqlite",
      () => {
        const adapter = new SqliteAdapter({
          path: ":memory:",
          forceJsCosine: true,
        });
        return { store: atomic(adapter.kv), close: () => adapter.close() };
      },
    ],
  ];
}

describe.each(stores())("%s atomic mutation contract", (_name, makeStore) => {
  it("supports missing/present/version conditions and fresh versions", () => {
    const { store, close } = makeStore();
    try {
      const created = store.mutateAtomically({
        conditions: [
          { target: { kind: "key", key: "counter" }, expected: "missing" },
        ],
        operations: [{ op: "set", key: "counter", value: 1 }],
      });
      expect(created.status).toBe("applied");
      if (created.status !== "applied") return;
      const version = created.versions[0]!.version!;
      expect(
        store.getVersioned<number>({ kind: "key", key: "counter" })?.version
      ).toBe(version);

      const updated = store.mutateAtomically({
        conditions: [
          {
            target: { kind: "key", key: "counter" },
            expected: "version",
            version,
          },
        ],
        operations: [{ op: "set", key: "counter", value: 2 }],
      });
      expect(updated.status).toBe("applied");
      if (updated.status === "applied")
        expect(updated.versions[0]!.version).not.toBe(version);
      expect(
        store.mutateAtomically({
          conditions: [
            {
              target: { kind: "key", key: "counter" },
              expected: "version",
              version,
            },
          ],
          operations: [{ op: "set", key: "counter", value: 3 }],
        })
      ).toMatchObject({ status: "conflict" });
    } finally {
      close?.();
    }
  });

  it("selects the canonical first conflict and commits all operations together", () => {
    const { store, close } = makeStore();
    try {
      store.set("z", "old");
      const conflict = store.mutateAtomically({
        conditions: [
          { target: { kind: "key", key: "z" }, expected: "missing" },
          { target: { kind: "key", key: "a" }, expected: "present" },
        ],
        operations: [{ op: "set", key: "should-not-write", value: true }],
      });
      expect(conflict).toMatchObject({
        status: "conflict",
        condition: { target: { key: "a" } },
        observed: "missing",
      });
      expect(store.get("should-not-write")).toBeNull();

      const applied = store.mutateAtomically({
        operations: [
          { op: "set", key: "one", value: 1 },
          { op: "put", collection: "records", item: { id: "r1", ok: true } },
        ],
      });
      expect(applied.status).toBe("applied");
      expect(
        applied.status === "applied"
          ? applied.versions.map(
              (entry: { target: StoreTarget }) => entry.target
            )
          : []
      ).toEqual([
        { kind: "key", key: "one" },
        { kind: "record", collection: "records", id: "r1" },
      ]);
    } finally {
      close?.();
    }
  });

  it("rejects repeated targets and non-JSON payloads before mutation", () => {
    const { store, close } = makeStore();
    try {
      expect(() =>
        store.mutateAtomically({
          operations: [
            { op: "set", key: "x", value: 1 },
            { op: "delete", key: "x" },
          ],
        })
      ).toThrowError(AtomicMutationRejectedError);
      expect(() =>
        store.mutateAtomically({
          operations: [{ op: "set", key: "x", value: Number.NaN }],
        })
      ).toThrowError(/JSON-safe/);
      expect(store.get("x")).toBeNull();
    } finally {
      close?.();
    }
  });

  it("keeps targets distinct when separators occur in collection names and ids", () => {
    const { store, close } = makeStore();
    try {
      const first = store.mutateAtomically({
        operations: [
          { op: "put", collection: "a\u0000b", item: { id: "c", value: 1 } },
          { op: "put", collection: "a", item: { id: "b\u0000c", value: 2 } },
        ],
      });
      expect(first.status).toBe("applied");
      if (first.status === "applied") {
        expect(first.versions).toHaveLength(2);
        expect(first.versions[0]?.target).not.toEqual(
          first.versions[1]?.target
        );
      }
      expect(store.getById("a\u0000b", "c")).toEqual({ id: "c", value: 1 });
      expect(store.getById("a", "b\u0000c")).toEqual({
        id: "b\u0000c",
        value: 2,
      });
    } finally {
      close?.();
    }
  });

  it("rejects sparse operation and condition arrays as typed invalid requests", () => {
    const { store, close } = makeStore();
    try {
      const operations = [] as unknown as Array<{
        op: "set";
        key: string;
        value: number;
      }>;
      operations.length = 1;
      expect(() => store.mutateAtomically({ operations })).toThrowError(
        AtomicMutationRejectedError
      );
      const conditions = [] as unknown as Array<StoreCondition>;
      conditions.length = 1;
      expect(() =>
        store.mutateAtomically({
          conditions,
          operations: [{ op: "set", key: "x", value: 1 }],
        })
      ).toThrowError(AtomicMutationRejectedError);
      expect(store.get("x")).toBeNull();
    } finally {
      close?.();
    }
  });

  it("counts the idempotency key toward the canonical request limit", () => {
    const { store, close } = makeStore();
    try {
      expect(() =>
        store.mutateAtomically({
          operations: [{ op: "set", key: "bounded", value: true }],
          idempotency: { key: "k".repeat(1024 * 1024) },
        })
      ).toThrowError(AtomicMutationRejectedError);
      expect(store.get("bounded")).toBeNull();
    } finally {
      close?.();
    }
  });

  it("replays idempotent outcomes and detects changed requests", () => {
    const { store, close } = makeStore();
    try {
      const request = {
        operations: [{ op: "set" as const, key: "once", value: { count: 1 } }],
        idempotency: { key: "same", outcome: { accepted: true } },
      };
      const first = store.mutateAtomically(request);
      const replay = store.mutateAtomically(request);
      expect(first.status).toBe("applied");
      expect(replay).toMatchObject({
        status: "replayed",
        ...(first.status === "applied"
          ? { requestDigest: first.requestDigest }
          : {}),
        outcome: { accepted: true },
      });
      expect(store.get<{ count: number }>("once")).toEqual({ count: 1 });
      expect(
        store.mutateAtomically({
          operations: [{ op: "set", key: "once", value: { count: 2 } }],
          idempotency: { key: "same", outcome: { accepted: true } },
        })
      ).toMatchObject({
        status: "idempotency-conflict",
      });
    } finally {
      close?.();
    }
  });
});

describe("atomic namespace and persistence behavior", () => {
  it("preserves capability and isolates values, versions, and idempotency keys", () => {
    const backing = new InMemoryKv();
    const first = atomic(namespaceStore(backing, "first"));
    const second = atomic(namespaceStore(backing, "second"));
    const applied = first.mutateAtomically({
      operations: [{ op: "set", key: "same", value: 1 }],
      idempotency: { key: "k" },
    });
    expect(applied.status).toBe("applied");
    expect(second.get("same")).toBeNull();
    expect(
      second.mutateAtomically({
        operations: [{ op: "set", key: "same", value: 2 }],
        idempotency: { key: "k" },
      })
    ).toMatchObject({ status: "applied" });
    expect(first.get("same")).toBe(1);
    expect(second.get("same")).toBe(2);
    const version = first.getVersioned({ kind: "key", key: "same" })!.version;
    expect(() =>
      second.mutateAtomically({
        conditions: [
          {
            target: { kind: "key", key: "same" },
            expected: "version",
            version,
          },
        ],
        operations: [{ op: "set", key: "other", value: true }],
      })
    ).toThrowError(AtomicMutationRejectedError);
  });

  it("persists SQLite versions and receipts across close/reopen", () => {
    const path = join(tmpdir(), `mirk-atomic-${process.pid}-${Date.now()}.db`);
    try {
      const first = new SqliteAdapter({ path });
      const request = {
        operations: [{ op: "set" as const, key: "persisted", value: "yes" }],
        idempotency: { key: "persist" },
      };
      const applied = first.kv.mutateAtomically(request);
      const version = first.kv.getVersioned({
        kind: "key",
        key: "persisted",
      })!.version;
      first.close();
      const reopened = new SqliteAdapter({ path });
      expect(
        reopened.kv.getVersioned({ kind: "key", key: "persisted" })?.version
      ).toBe(version);
      expect(reopened.kv.mutateAtomically(request)).toMatchObject({
        status: "replayed",
        ...(applied.status === "applied"
          ? { requestDigest: applied.requestDigest }
          : {}),
      });
      reopened.close();
    } finally {
      rmSync(path, { force: true });
      rmSync(`${path}-wal`, { force: true });
      rmSync(`${path}-shm`, { force: true });
    }
  });
});

describe("SQLite atomic two-process behavior", () => {
  beforeAll(() => {
    execFileSync("pnpm", ["--filter", "@mirk/store", "build"], {
      cwd: resolve(dirname(fileURLToPath(import.meta.url)), "../.."),
      stdio: "inherit",
    });
  }, 60_000);

  it("admits exactly one competing create-if-missing winner", async () => {
    const root = join(
      tmpdir(),
      `mirk-atomic-process-${process.pid}-${Date.now()}`
    );
    mkdirSync(root, { recursive: true });
    const dbPath = join(root, "atomic.sqlite");
    const workerPath = resolve(root, "worker.mjs");
    const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const adapterEntry = pathToFileURL(
      resolve(packageRoot, "dist/adapters/sqlite.js")
    ).href;
    writeFileSync(
      workerPath,
      `
      import { SqliteAdapter } from ${JSON.stringify(adapterEntry)};
      const options = JSON.parse(process.argv[2]);
      const adapter = new SqliteAdapter({ path: options.dbPath, busyTimeoutMs: 5_000 });
      const result = adapter.kv.mutateAtomically({
        conditions: [{ target: { kind: 'key', key: 'race' }, expected: 'missing' }],
        operations: [{ op: 'set', key: 'race', value: options.value }],
        idempotency: { key: 'race-' + options.value },
      });
      if (process.send) process.send(result);
      adapter.close();
    `,
      "utf8"
    );
    const run = (value: string) =>
      new Promise<Record<string, unknown>>((resolveResult, reject) => {
        const child = fork(workerPath, [JSON.stringify({ dbPath, value })], {
          stdio: ["ignore", "ignore", "inherit", "ipc"],
        }) as unknown as {
          on(event: string, listener: (...args: any[]) => void): void;
        };
        child.on("message", (result: unknown) =>
          resolveResult(result as Record<string, unknown>)
        );
        child.on("error", (error: Error) => reject(error));
        child.on("exit", (code: number) => {
          if (code !== 0) reject(new Error(`worker exited with ${code}`));
        });
      });
    try {
      const results = await Promise.all([run("a"), run("b")]);
      expect(
        results.filter((result) => result.status === "applied")
      ).toHaveLength(1);
      expect(
        results.filter((result) => result.status === "conflict")
      ).toHaveLength(1);
      const adapter = new SqliteAdapter({ path: dbPath });
      expect(["a", "b"]).toContain(adapter.kv.get("race"));
      adapter.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});

describe("atomic canonical JSON", () => {
  it("sorts object keys while preserving array order", () => {
    expect(canonicalJson({ b: 1, a: [2, 1] })).toBe('{"a":[2,1],"b":1}');
  });

  it("rejects enumerable array properties that JSON would silently drop", () => {
    const value = [1] as unknown as Record<string, unknown>;
    value["01"] = "alias";
    expect(() => canonicalJson(value)).toThrow(/array properties/);
  });
});
