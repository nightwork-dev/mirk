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
  supportsAsyncAtomicMutation,
  supportsAtomicMutation,
  toAsync,
} from "./index.js";
import { SqliteAdapter } from "./adapters/sqlite.js";
import type {
  AtomicMutationLimits,
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

interface StoreOptions {
  atomicLimits?: Partial<AtomicMutationLimits>;
}

type MakeStore = (options?: StoreOptions) => {
  store: AtomicStore;
  close?: () => void;
};

function stores(): Array<[string, MakeStore]> {
  return [
    ["memory", (options) => ({ store: atomic(new InMemoryKv(options)) })],
    [
      "sqlite",
      (options) => {
        const adapter = new SqliteAdapter({
          path: ":memory:",
          ...options,
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
    const { store, close } = makeStore({
      atomicLimits: { maxRequestBytes: 4096 },
    });
    try {
      expect(() =>
        store.mutateAtomically({
          operations: [{ op: "set", key: "bounded", value: true }],
          idempotency: { key: "k".repeat(8192) },
        })
      ).toThrowError(AtomicMutationRejectedError);
      expect(store.get("bounded")).toBeNull();
    } finally {
      close?.();
    }
  });

  it("accepts a batch far above the old fixed 128-operation limit", () => {
    const { store, close } = makeStore();
    try {
      expect(store.atomicLimits.maxOperations).toBeGreaterThanOrEqual(4096);
      const operations = Array.from({ length: 200 }, (_, index) => ({
        op: "set" as const,
        key: `wide:${index}`,
        value: index,
      }));
      const applied = store.mutateAtomically({ operations });
      expect(applied.status).toBe("applied");
      if (applied.status !== "applied") return;
      expect(applied.versions).toHaveLength(200);
      expect(store.get("wide:0")).toBe(0);
      expect(store.get("wide:199")).toBe(199);
    } finally {
      close?.();
    }
  });

  it("rejects above an overridden operation limit and names the limit", () => {
    const { store, close } = makeStore({ atomicLimits: { maxOperations: 10 } });
    try {
      expect(store.atomicLimits.maxOperations).toBe(10);
      const operations = Array.from({ length: 11 }, (_, index) => ({
        op: "set" as const,
        key: `narrow:${index}`,
        value: index,
      }));
      let thrown: unknown;
      try {
        store.mutateAtomically({ operations });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(AtomicMutationRejectedError);
      const rejection = thrown as AtomicMutationRejectedError;
      expect(rejection.code).toBe("operation-limit-exceeded");
      expect(rejection.message).toContain("11 operations");
      expect(rejection.message).toContain("maxOperations is 10");
      expect(store.get("narrow:0")).toBeNull();

      // Ten is still accepted, so the boundary is the override and not an
      // off-by-one around it.
      expect(
        store.mutateAtomically({ operations: operations.slice(0, 10) }).status
      ).toBe("applied");
    } finally {
      close?.();
    }
  });

  it("rejects a condition count above an overridden condition limit", () => {
    const { store, close } = makeStore({ atomicLimits: { maxConditions: 2 } });
    try {
      const conditions = Array.from({ length: 3 }, (_, index) => ({
        target: { kind: "key" as const, key: `cond:${index}` },
        expected: "missing" as const,
      }));
      let thrown: unknown;
      try {
        store.mutateAtomically({
          conditions,
          operations: [{ op: "set", key: "cond:out", value: 1 }],
        });
      } catch (error) {
        thrown = error;
      }
      expect((thrown as AtomicMutationRejectedError).code).toBe(
        "condition-limit-exceeded"
      );
      expect((thrown as Error).message).toContain("maxConditions is 2");
      expect(store.get("cond:out")).toBeNull();
    } finally {
      close?.();
    }
  });

  it("keeps the outcome cap fixed no matter how the limits are raised", () => {
    const { store, close } = makeStore({
      atomicLimits: {
        maxOperations: 4096,
        maxConditions: 4096,
        maxRequestBytes: 64 * 1024 * 1024,
      },
    });
    try {
      // 64 KiB of payload plus the JSON quotes is over the fixed cap.
      const outcome = { note: "o".repeat(64 * 1024) };
      let thrown: unknown;
      try {
        store.mutateAtomically({
          operations: [{ op: "set", key: "capped", value: 1 }],
          idempotency: { key: "capped", outcome },
        });
      } catch (error) {
        thrown = error;
      }
      expect((thrown as AtomicMutationRejectedError).code).toBe(
        "outcome-size-exceeded"
      );
      expect((thrown as Error).message).toContain("65536");
      expect(store.get("capped")).toBeNull();

      // Just under the cap is still accepted, so the failure above is the cap
      // and not the payload being malformed.
      expect(
        store.mutateAtomically({
          operations: [{ op: "set", key: "capped", value: 1 }],
          idempotency: {
            key: "capped",
            outcome: { note: "o".repeat(60 * 1024) },
          },
        }).status
      ).toBe("applied");
    } finally {
      close?.();
    }
  });

  it("reports the same limits through the namespaced and async wrappers", () => {
    const { store, close } = makeStore({ atomicLimits: { maxOperations: 77 } });
    try {
      const namespaced = atomic(namespaceStore(store, "bound"));
      expect(namespaced.atomicLimits).toEqual(store.atomicLimits);
      expect(namespaced.atomicLimits.maxOperations).toBe(77);

      const lifted = toAsync(store);
      expect(supportsAsyncAtomicMutation(lifted)).toBe(true);
      if (!supportsAsyncAtomicMutation(lifted)) return;
      expect(lifted.atomicLimits).toEqual(store.atomicLimits);

      const liftedNamespace = toAsync(namespaced);
      if (!supportsAsyncAtomicMutation(liftedNamespace)) {
        throw new Error("namespaced store lost the capability when lifted");
      }
      expect(liftedNamespace.atomicLimits.maxOperations).toBe(77);
    } finally {
      close?.();
    }
  });

  it("rejects above the inner limit through the namespaced wrapper", () => {
    const { store, close } = makeStore({ atomicLimits: { maxOperations: 3 } });
    try {
      const namespaced = atomic(namespaceStore(store, "bound"));
      const operations = Array.from({ length: 4 }, (_, index) => ({
        op: "set" as const,
        key: `n:${index}`,
        value: index,
      }));
      expect(() => namespaced.mutateAtomically({ operations })).toThrowError(
        /maxOperations is 3/
      );
      expect(namespaced.get("n:0")).toBeNull();
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

  it("commits, rolls back, and reopens a 200-operation batch on a file", () => {
    const path = join(
      tmpdir(),
      `mirk-atomic-wide-${process.pid}-${Date.now()}.db`
    );
    try {
      const first = new SqliteAdapter({ path });
      const operations = Array.from({ length: 200 }, (_, index) => ({
        op: "set" as const,
        key: `wide:${index}`,
        value: index,
      }));
      expect(first.kv.mutateAtomically({ operations }).status).toBe("applied");

      // A failing condition on a second 200-operation batch must leave nothing
      // behind: the whole batch rolls back, not the operations after the check.
      const second = Array.from({ length: 200 }, (_, index) => ({
        op: "set" as const,
        key: `rolled:${index}`,
        value: index,
      }));
      const conflict = first.kv.mutateAtomically({
        conditions: [
          { target: { kind: "key", key: "wide:0" }, expected: "missing" },
        ],
        operations: second,
      });
      expect(conflict.status).toBe("conflict");
      expect(first.kv.get("rolled:0")).toBeNull();
      expect(first.kv.get("rolled:199")).toBeNull();
      first.close();

      const reopened = new SqliteAdapter({ path });
      expect(reopened.kv.get("wide:0")).toBe(0);
      expect(reopened.kv.get("wide:199")).toBe(199);
      expect(reopened.kv.keys("rolled:")).toEqual([]);
      expect(reopened.kv.keys("wide:")).toHaveLength(200);
      reopened.close();
    } finally {
      rmSync(path, { force: true });
      rmSync(`${path}-wal`, { force: true });
      rmSync(`${path}-shm`, { force: true });
    }
  });

  it("honors an adapter-level limit override on a file database", () => {
    const path = join(
      tmpdir(),
      `mirk-atomic-capped-${process.pid}-${Date.now()}.db`
    );
    try {
      const adapter = new SqliteAdapter({
        path,
        atomicLimits: { maxOperations: 10 },
      });
      expect(adapter.kv.atomicLimits.maxOperations).toBe(10);
      // The other two bounds fall back to the in-process defaults.
      expect(adapter.kv.atomicLimits.maxConditions).toBe(1024);
      expect(adapter.kv.atomicLimits.maxRequestBytes).toBe(16 * 1024 * 1024);
      expect(() =>
        adapter.kv.mutateAtomically({
          operations: Array.from({ length: 11 }, (_, index) => ({
            op: "set" as const,
            key: `k:${index}`,
            value: index,
          })),
        })
      ).toThrowError(/maxOperations is 10/);
      adapter.close();
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

describe("atomic request digest and version identity", () => {
  it("computes one request digest for the same operations under different idempotency keys", () => {
    const store = atomic(new InMemoryKv());
    const operations = [{ op: "set" as const, key: "a", value: true }];
    const first = store.mutateAtomically({
      operations,
      idempotency: { key: "one" },
    });
    const second = store.mutateAtomically({
      operations,
      idempotency: { key: "two" },
    });
    expect(first.status).toBe("applied");
    expect(second.status).toBe("applied");
    const digestOf = (result: typeof first): string => {
      if (result.status !== "applied") throw new Error(`expected applied, got ${result.status}`);
      return result.requestDigest;
    };
    const bare = store.mutateAtomically({ operations });
    expect(digestOf(second)).toBe(digestOf(first));
    // The key is excluded from the digest input entirely, so a request carrying
    // no key at all has the same identity as the two that did.
    expect(digestOf(bare)).toBe(digestOf(first));
  });

  it("mints version tokens under an injected identity in both backends", () => {
    const memory = atomic(new InMemoryKv({ versionIdentity: "pinned" }));
    memory.set("a", 1);
    expect(memory.getVersioned({ kind: "key", key: "a" })?.version).toBe("pinned-v1");

    const adapter = new SqliteAdapter({ path: ":memory:", versionIdentity: "pinned" });
    try {
      adapter.kv.set("a", 1);
      expect(adapter.kv.getVersioned({ kind: "key", key: "a" })?.version).toBe("pinned-v1");
    } finally {
      adapter.close();
    }
  });

  it("keeps the identity a SQLite file was created with when it is reopened with another", () => {
    const path = join(tmpdir(), `mirk-identity-${process.pid}-${Date.now()}.db`);
    try {
      const first = new SqliteAdapter({ path, versionIdentity: "original" });
      first.kv.set("a", 1);
      expect(first.kv.getVersioned({ kind: "key", key: "a" })?.version).toBe("original-v1");
      first.close();

      const second = new SqliteAdapter({ path, versionIdentity: "replacement" });
      try {
        expect(second.kv.getVersioned({ kind: "key", key: "a" })?.version).toBe("original-v1");
        second.kv.set("b", 2);
        expect(second.kv.getVersioned({ kind: "key", key: "b" })?.version).toBe("original-v2");
      } finally {
        second.close();
      }
    } finally {
      rmSync(path, { force: true });
      rmSync(`${path}-wal`, { force: true });
      rmSync(`${path}-shm`, { force: true });
    }
  });
});
