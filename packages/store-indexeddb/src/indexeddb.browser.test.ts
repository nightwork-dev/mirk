import { afterEach, describe, expect, it } from "vitest";
import {
  IndexedDbConnectionError,
  openIndexedDbAdapter,
  type IndexedDbAdapter,
  type IndexedDbExport,
} from "./index.js";
import type { StoreVersion } from "@mirk/store";

const opened: IndexedDbAdapter[] = [];
const names: string[] = [];

afterEach(async () => {
  for (const adapter of opened.splice(0)) await adapter.close();
  for (const name of names.splice(0)) await deleteDatabase(name);
});

function newName(): string {
  const name = `mirk-indexeddb-test-${crypto.randomUUID()}`;
  names.push(name);
  return name;
}

async function open(name: string, options: { versionIdentity?: string } = { versionIdentity: "test" }): Promise<IndexedDbAdapter> {
  const adapter = await openIndexedDbAdapter({ dbName: name, ...options });
  opened.push(adapter);
  return adapter;
}

function deleteDatabase(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = request.onblocked = () => resolve();
    request.onerror = () => reject(request.error ?? new Error("delete failed"));
  });
}

describe("IndexedDB source adapter", () => {
  it("persists records through close and reopen, with stable collection ordering", async () => {
    const name = newName();
    const first = await open(name);
    await first.set("setting", { enabled: true });
    await first.put("items", { id: "b", rank: 2 });
    await first.put("items", { id: "a", rank: 1 });
    await first.put("items", { id: "b", rank: 3 });
    const versioned = await first.getVersioned({ kind: "record", collection: "items", id: "b" });
    expect(versioned?.value).toEqual({ id: "b", rank: 3 });
    expect(await first.list("items")).toEqual([
      { id: "b", rank: 3 },
      { id: "a", rank: 1 },
    ]);
    await first.close();
    opened.splice(opened.indexOf(first), 1);

    const reopened = await open(name);
    expect(await reopened.get("setting")).toEqual({ enabled: true });
    expect(await reopened.getById("items", "b")).toEqual({ id: "b", rank: 3 });
    expect(await reopened.keys()).toEqual(["setting"]);
  });

  it("evaluates conditions and idempotency in one transaction", async () => {
    const name = newName();
    const adapter = await open(name);
    const created = await adapter.mutateAtomically({
      conditions: [{ target: { kind: "key", key: "counter" }, expected: "missing" }],
      operations: [{ op: "set", key: "counter", value: 1 }],
      idempotency: { key: "command-1", outcome: { accepted: true } },
    });
    expect(created.status).toBe("applied");
    const replay = await adapter.mutateAtomically({
      conditions: [{ target: { kind: "key", key: "counter" }, expected: "missing" }],
      operations: [{ op: "set", key: "counter", value: 1 }],
      idempotency: { key: "command-1", outcome: { accepted: true } },
    });
    expect(replay).toMatchObject({ status: "replayed", outcome: { accepted: true } });
    const reused = await adapter.mutateAtomically({
      operations: [{ op: "set", key: "counter", value: 2 }],
      idempotency: { key: "command-1" },
    });
    expect(reused.status).toBe("idempotency-conflict");
    expect(await adapter.get("counter")).toBe(1);
  });

  it("serializes concurrent writers and reports a version conflict", async () => {
    const name = newName();
    const first = await open(name);
    const second = await open(name);
    await first.set("head", { revision: 0 });
    const current = await first.getVersioned<{ revision: number }>({ kind: "key", key: "head" });
    expect(current).not.toBeNull();
    const request = (value: number) => second.mutateAtomically({
      conditions: [{ target: { kind: "key", key: "head" }, expected: "version", version: current!.version }],
      operations: [{ op: "set", key: "head", value: { revision: value } }],
    });
    const [left, right] = await Promise.all([request(1), request(2)]);
    expect([left.status, right.status].sort()).toEqual(["applied", "conflict"]);
    expect((await first.get<{ revision: number }>("head"))?.revision).toBe(1);
  });

  it("provides coherent reads and complete generic export/import", async () => {
    const source = await open(newName());
    await source.set("head", { revision: 1 });
    await source.put("facts", { id: "fact-one", command: "one" });
    await source.mutateAtomically({
      operations: [{ op: "set", key: "saved", value: true }],
      idempotency: { key: "receipt-one", outcome: { ok: true } },
    });
    const coherent = await source.readTransaction((view) => ({
      head: view.get<{ revision: number }>("head"),
      facts: view.list("facts"),
    }));
    expect(coherent).toEqual({ head: { revision: 1 }, facts: [{ id: "fact-one", command: "one" }] });
    const exported = await source.exportState();
    expect(exported.receipts).toHaveLength(1);
    expect(exported.records).toEqual(expect.arrayContaining([
      expect.objectContaining({ collection: "facts", id: "fact-one" }),
    ]));

    const restored = await open(newName());
    await restored.importState(exported as IndexedDbExport);
    expect(await restored.getById("facts", "fact-one")).toEqual({ id: "fact-one", command: "one" });
    expect(await restored.mutateAtomically({
      operations: [{ op: "set", key: "saved", value: true }],
      idempotency: { key: "receipt-one", outcome: { ok: true } },
    })).toMatchObject({ status: "replayed", outcome: { ok: true } });
  });

  it("rejects corrupt backups before replacing data and preserves durable rows after an abort", async () => {
    const adapter = await open(newName());
    await adapter.set("head", { revision: 4 });
    await adapter.mutateAtomically({
      operations: [{ op: "set", key: "marker", value: true }],
      idempotency: { key: "durable-receipt", outcome: { ok: true } },
    });
    const exported = await adapter.exportState();
    const corrupt = {
      ...exported,
      kv: [...exported.kv, exported.kv[0]!],
    };
    await expect(adapter.importState(corrupt)).rejects.toMatchObject({
      name: "IndexedDbBackupError",
      code: "duplicate-row",
    });
    expect(await adapter.get("head")).toEqual({ revision: 4 });
    expect(await adapter.mutateAtomically({
      operations: [{ op: "set", key: "marker", value: true }],
      idempotency: { key: "durable-receipt", outcome: { ok: true } },
    })).toMatchObject({ status: "replayed", outcome: { ok: true } });

    await expect(adapter.set("bad", { callback: () => undefined })).rejects.toMatchObject({
      name: "AtomicMutationBackendError",
      code: "serialization-failure",
    });
    expect(await adapter.get("head")).toEqual({ revision: 4 });
    expect(await adapter.get("bad")).toBeNull();
  });
});

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function rawOpen(name: string, version: number, upgrade?: (db: IDBDatabase) => void): Promise<IDBDatabase> {
  const req = indexedDB.open(name, version);
  req.onupgradeneeded = () => upgrade?.(req.result);
  return request(req);
}

describe("versions", () => {
  it("a plain write issues a fresh version, so a condition read before it conflicts", async () => {
    const adapter = await open(newName());
    await adapter.set("head", 1);
    const before = await adapter.getVersioned({ kind: "key", key: "head" });
    await adapter.set("head", 2);
    const after = await adapter.getVersioned({ kind: "key", key: "head" });
    expect(after?.version).not.toBe(before?.version);

    const stale = await adapter.mutateAtomically({
      conditions: [{ target: { kind: "key", key: "head" }, expected: "version", version: before!.version }],
      operations: [{ op: "set", key: "head", value: 3 }],
    });
    expect(stale).toMatchObject({ status: "conflict", observed: after!.version });
    expect(await adapter.get("head")).toBe(2);

    const view = await adapter.readTransaction((read) => ({
      head: read.getVersioned({ kind: "key", key: "head" }),
      missing: read.get("missing"),
    }));
    expect(view).toEqual({ head: after, missing: null });

    await adapter.delete("head");
    expect(await adapter.readTransaction((read) => read.getVersioned({ kind: "key", key: "head" }))).toBeNull();
  });

  it("two databases opened without an identity never share version tokens, and a reopen keeps its own", async () => {
    const firstName = newName();
    const first = await open(firstName, {});
    const second = await open(newName(), {});
    await first.set("a", 1);
    await second.set("a", 1);
    const firstVersion = (await first.getVersioned({ kind: "key", key: "a" }))!.version;
    const secondVersion = (await second.getVersioned({ kind: "key", key: "a" }))!.version;
    expect(firstVersion).not.toBe(secondVersion);

    await first.close();
    const reopened = await open(firstName, {});
    await reopened.set("b", 2);
    const reopenedVersion = (await reopened.getVersioned({ kind: "key", key: "b" }))!.version;
    const prefix = (version: string) => version.slice(0, version.lastIndexOf("-v"));
    expect(prefix(reopenedVersion)).toBe(prefix(firstVersion));
  });

  it("a database written by an earlier adapter opens with versions for its existing keys", async () => {
    const name = newName();
    const legacy = await rawOpen(name, 1, (db) => {
      db.createObjectStore("kv", { keyPath: "key" });
      db.createObjectStore("records", { keyPath: ["collection", "id"] }).createIndex("collection", "collection");
      db.createObjectStore("versions", { keyPath: "targetKey" });
      db.createObjectStore("receipts", { keyPath: "key" });
      db.createObjectStore("meta", { keyPath: "name" });
    });
    const tx = legacy.transaction(["kv"], "readwrite");
    tx.objectStore("kv").put({ key: "settings", value: { sound: true } });
    await new Promise((resolve) => (tx.oncomplete = resolve));
    legacy.close();

    const adapter = await open(name);
    const current = await adapter.getVersioned({ kind: "key", key: "settings" });
    expect(current?.value).toEqual({ sound: true });
    const applied = await adapter.mutateAtomically({
      conditions: [{ target: { kind: "key", key: "settings" }, expected: "version", version: current!.version }],
      operations: [{ op: "set", key: "settings", value: { sound: false } }],
    });
    expect(applied.status).toBe("applied");
  });

  it("a version handed out by an earlier adapter cannot overwrite a later plain write after upgrade", async () => {
    const name = newName();
    const legacy = await rawOpen(name, 1, (db) => {
      db.createObjectStore("kv", { keyPath: "key" });
      db.createObjectStore("records", { keyPath: ["collection", "id"] }).createIndex("collection", "collection");
      db.createObjectStore("versions", { keyPath: "targetKey" });
      db.createObjectStore("receipts", { keyPath: "key" });
      db.createObjectStore("meta", { keyPath: "name" });
    });
    // The earlier adapter issued idb1-v1 for "A"; its plain set of "B" left that row in place.
    const tx = legacy.transaction(["kv", "versions", "meta"], "readwrite");
    tx.objectStore("kv").put({ key: "k1", value: "B" });
    tx.objectStore("versions").put({ targetKey: "k:2:k1", version: "idb1-v1" });
    tx.objectStore("meta").put({ name: "state", versionIdentity: "idb1", nextVersion: 2, nextOrdinal: 1 });
    await new Promise((resolve) => (tx.oncomplete = resolve));
    legacy.close();

    const adapter = await open(name);
    const stale = await adapter.mutateAtomically({
      conditions: [{ target: { kind: "key", key: "k1" }, expected: "version", version: "idb1-v1" as StoreVersion }],
      operations: [{ op: "set", key: "k1", value: "C" }],
    });
    expect(stale.status).toBe("conflict");
    expect(await adapter.get("k1")).toBe("B");
    const current = (await adapter.getVersioned({ kind: "key", key: "k1" }))!.version;
    expect(current.startsWith("idb1-")).toBe(false);
  });
});

describe("another tab changes the database", () => {
  it("another tab can upgrade the database while this tab has it open", async () => {
    const name = newName();
    const adapter = await open(name);
    await adapter.set("a", 1);

    const upgraded = await rawOpen(name, 3);
    upgraded.close();

    await expect(adapter.get("a")).rejects.toBeInstanceOf(IndexedDbConnectionError);
    await expect(adapter.get("a")).rejects.toMatchObject({ code: "version-change", retryable: true });
    await expect(openIndexedDbAdapter({ dbName: name })).rejects.toMatchObject({
      name: "IndexedDbConnectionError",
      code: "version-too-new",
      retryable: false,
    });
  });

  it("another tab can delete the database while this tab has it open", async () => {
    const name = newName();
    const adapter = await open(name);
    await adapter.set("a", 1);

    let blocked = false;
    const deletion = indexedDB.deleteDatabase(name);
    deletion.onblocked = () => {
      blocked = true;
    };
    await request(deletion);
    expect(blocked).toBe(false);
    await expect(adapter.set("b", 2)).rejects.toMatchObject({ code: "version-change" });
  });

  it("an open blocked by an older connection fails fast and does not keep a connection once it unblocks", async () => {
    const name = newName();
    const older = await rawOpen(name, 1);
    await expect(openIndexedDbAdapter({ dbName: name })).rejects.toMatchObject({
      name: "IndexedDbConnectionError",
      code: "blocked",
      retryable: true,
    });
    older.close();

    let blocked = false;
    const deletion = indexedDB.deleteDatabase(name);
    deletion.onblocked = () => {
      blocked = true;
    };
    await request(deletion);
    expect(blocked).toBe(false);
  });
});

describe("closing", () => {
  it("calls after close fail with a non-retryable coded error", async () => {
    const adapter = await openIndexedDbAdapter({ dbName: newName() });
    await adapter.close();
    await expect(adapter.get("a")).rejects.toMatchObject({
      name: "IndexedDbConnectionError",
      code: "closed",
      retryable: false,
    });
  });
});
