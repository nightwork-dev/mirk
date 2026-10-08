import { InMemoryKv, toAsync } from "@mirk/store/kv";
import { SqliteAdapter } from "@mirk/store/sqlite";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  InMemoryArtifactRepository,
  type StoredArtifactRecord,
} from "../src/index.js";
import { ArtifactOperationError, StoreArtifactRepository } from "../src/store.js";

const record = (id: string, createdAt: number): StoredArtifactRecord => ({ id, objectKey: `objects/${id}`, mediaType: "text/plain", sizeBytes: 1, digest: { algorithm: "sha256", value: id }, createdAt });

describe("StoreArtifactRepository", () => {
  async function assertLeaseObjectIdentity(
    repository: InMemoryArtifactRepository | StoreArtifactRepository,
  ): Promise<void> {
    const writer = await repository.acquireObjectLease({
      objectKey: "A",
      ownerId: "writer",
      mode: "shared-writer",
      now: 0,
    });
    const blocker = await repository.acquireObjectLease({
      objectKey: "B",
      ownerId: "repair",
      mode: "exclusive-delete",
      now: 0,
    });
    expect(writer.status).toBe("acquired");
    expect(blocker.status).toBe("acquired");
    if (writer.status !== "acquired") return;
    const candidate: StoredArtifactRecord = {
      ...record("blocked", 0),
      objectKey: "B",
    };
    expect(
      await repository.createWithLease({
        record: candidate,
        lease: writer.lease,
        now: 0,
      })
    ).toEqual({ status: "lease-lost" });
    expect(
      await repository.createIdempotentWithLease({
        record: { ...candidate, id: "blocked-idempotent" },
        idempotencyKey: "blocked",
        lease: writer.lease,
        now: 0,
      })
    ).toEqual({ status: "lease-lost" });
    expect(await repository.get("blocked")).toBeUndefined();
    expect(await repository.get("blocked-idempotent")).toBeUndefined();
    expect(await repository.getByIdempotencyKey("blocked")).toBeUndefined();
  }

  it("persists records and deterministic cursors over @mirk/store", async () => {
    const store = toAsync(new InMemoryKv());
    const first = new StoreArtifactRepository(store, { namespace: "test" });
    await first.create(record("a", 1));
    await first.create(record("b", 2));
    const page = await first.list({ limit: 1 });
    expect(page.items.map((item) => item.id)).toEqual(["b"]);
    const reopened = new StoreArtifactRepository(store, { namespace: "test" });
    expect((await reopened.list({ limit: 1, cursor: page.nextCursor })).items.map((item) => item.id)).toEqual(["a"]);
  });

  it("survives a real SQLite close and reopen", async () => {
    const path = join(tmpdir(), `mirk-artifact-${process.pid}-${Date.now()}.db`);
    try {
      const firstStore = new SqliteAdapter({ path });
      await new StoreArtifactRepository(toAsync(firstStore.kv)).create(record("persisted", 7));
      firstStore.close();
      const reopenedStore = new SqliteAdapter({ path });
      expect((await new StoreArtifactRepository(toAsync(reopenedStore.kv)).get("persisted"))?.objectKey).toBe("objects/persisted");
      reopenedStore.close();
    } finally {
      for (const suffix of ["", "-wal", "-shm"]) rmSync(`${path}${suffix}`, { force: true });
    }
  });

  it("rejects cursors that do not belong to the result set", async () => {
    const repository = new StoreArtifactRepository(toAsync(new InMemoryKv()));
    await repository.create(record("a", 1));
    const rejection = expect(repository.list({ cursor: "missing" })).rejects;
    await rejection.toThrow(ArtifactOperationError);
    await rejection.toMatchObject({ code: "invalid-cursor" });
  });

  it("fences lease commits by object identity in the memory reference", async () => {
    await assertLeaseObjectIdentity(new InMemoryArtifactRepository({ now: () => 0 }));
  });

  it("fences lease commits by object identity in real SQLite", async () => {
    const path = join(tmpdir(), `mirk-artifact-lease-identity-${process.pid}-${Date.now()}.db`);
    const database = new SqliteAdapter({ path });
    try {
      const store = toAsync(database.kv);
      const repository = new StoreArtifactRepository(store, {
        namespace: "lease-test",
        now: () => 0,
      });
      await assertLeaseObjectIdentity(repository);
      expect(await store.get("lease-test:idempotency:blocked")).toBeNull();
    } finally {
      database.close();
      for (const suffix of ["", "-wal", "-shm"]) rmSync(`${path}${suffix}`, { force: true });
    }
  });

  it("keeps an idempotency tombstone after record deletion", async () => {
    const repositories = [
      new InMemoryArtifactRepository({ now: () => 0 }),
      new StoreArtifactRepository(toAsync(new InMemoryKv()), {
        namespace: "tombstone",
        now: () => 0,
      }),
    ];
    for (const repository of repositories) {
      const candidate = record("deleted", 0);
      expect(
        (await repository.createIdempotent({
          record: candidate,
          idempotencyKey: "deleted-key",
        })).status
      ).toBe("created");
      expect(await repository.delete("deleted")).toBe(true);
      const lease = await repository.acquireObjectLease({
        objectKey: "objects/deleted",
        ownerId: "writer",
        mode: "shared-writer",
        now: 0,
      });
      expect(lease.status).toBe("acquired");
      if (lease.status !== "acquired") continue;
      expect(
        await repository.createIdempotentWithLease({
          record: candidate,
          idempotencyKey: "deleted-key",
          lease: lease.lease,
          now: 0,
        })
      ).toMatchObject({ status: "conflict" });
      expect(await repository.get("deleted")).toBeUndefined();
    }
  });
});
