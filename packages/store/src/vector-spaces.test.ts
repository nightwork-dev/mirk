import { describe, it, expect } from "vitest";
import { InMemoryVectorStore } from "./vector/memory.js";
import { SqliteAdapter } from "./adapters/sqlite.js";
import { NodeSqliteAdapter } from "./adapters/node-sqlite.js";
import type { VectorStore } from "./vector/types.js";
const v = (...n: number[]) => Float32Array.from(n);
for (const backend of ["memory", "sqlite", "node"] as const)
  describe(`named spaces ${backend}`, () => {
    it("searches independent dimensions, replaces complete documents and rejects a batch atomically", () => {
      const adapter =
        backend === "memory"
          ? undefined
          : backend === "sqlite"
            ? new SqliteAdapter({ path: ":memory:" })
            : new NodeSqliteAdapter({ path: ":memory:" });
      const store: VectorStore = adapter?.vector ?? new InMemoryVectorStore();
      try {
        store.ensureSpace("text", { dimensions: 2 });
        store.ensureSpace("image", { dimensions: 3 });
        store.ensureSpace("text", { dimensions: 2 });
        expect(store.listSpaces().map((s) => s.name)).toEqual([
          "image",
          "text",
        ]);
        expect(() => store.ensureSpace("text", { dimensions: 3 })).toThrow(
          expect.objectContaining({ code: "space-definition-conflict" }),
        );
        store.upsert("assets", {
          id: "a",
          vectors: { text: v(1, 0), image: v(0, 1, 0) },
          metadata: { kind: "art" },
        });
        expect(
          store
            .search("assets", { space: "image", vector: v(0, 1, 0) })
            .map((r) => r.id),
        ).toEqual(["a"]);
        store.upsert("assets", { id: "a", vectors: { text: v(0, 1) } });
        expect(store.get("assets", "a")!.metadata).toBeUndefined();
        expect(Object.keys(store.get("assets", "a")!.vectors)).toEqual([
          "text",
        ]);
        expect(
          store.search("assets", { space: "image", vector: v(0, 1, 0) }),
        ).toEqual([]);
        expect(() =>
          store.upsertMany("assets", [
            { id: "a", vectors: { text: v(1, 0) } },
            { id: "b", vectors: { missing: v(1) } },
          ]),
        ).toThrow(expect.objectContaining({ code: "unknown-space" }));
        expect(Array.from(store.get("assets", "a")!.vectors.text!)).toEqual([
          0, 1,
        ]);
        expect(store.count("assets")).toBe(1);
        expect(() =>
          store.upsert("assets", { id: "empty", vectors: {} }),
        ).toThrow(expect.objectContaining({ code: "empty-vectors" }));
        expect(store.remove("assets", "a")).toBe(true);
        expect(store.count("assets")).toBe(0);
      } finally {
        adapter?.close();
      }
    });
  });
