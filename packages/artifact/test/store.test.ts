import { InMemoryKv, toAsync } from "@mirk/store/kv";
import { SqliteAdapter } from "@mirk/store/sqlite";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { StoredArtifactRecord } from "../src/index.js";
import { StoreArtifactRepository } from "../src/store.js";

const record = (id: string, createdAt: number): StoredArtifactRecord => ({ id, objectKey: `objects/${id}`, mediaType: "text/plain", sizeBytes: 1, digest: { algorithm: "sha256", value: id }, createdAt });

describe("StoreArtifactRepository", () => {
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
    await expect(repository.list({ cursor: "missing" })).rejects.toThrow("invalid artifact cursor");
  });
});
