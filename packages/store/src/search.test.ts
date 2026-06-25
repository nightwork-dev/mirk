// ─── @mirk/store/search tests ───────────────────────────────────────────────
// One suite, run against InMemory and SQLite (in-memory db) backends. Mirrors
// src/vector.test.ts: a shared body proves the two backends agree on the SET of
// matching documents, the RANKING ORDER on clear relevance differences, the
// filter, and remove. Exact bm25 float scores need NOT match across backends —
// assert order, not equality (same parity caveat as /vector).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
import Database from "better-sqlite3";

import type { SearchStore } from "./search/types.js";
import { InMemorySearchStore } from "./search/memory.js";
import { SqliteAdapter } from "./adapters/sqlite.js";
import { hashName } from "./sql.js";

interface Made {
  store: SearchStore;
  cleanup?: () => void;
}

function searchTableNames(collection: string): { docs: string; fts: string } {
  const safe = collection.replace(/[^a-zA-Z0-9_]/g, "_");
  const hash = hashName(collection);
  return { docs: `search_docs_${safe}_${hash}`, fts: `search_fts_${safe}_${hash}` };
}

function suite(name: string, make: () => Promise<Made>): void {
  describe(name, () => {
    let store: SearchStore;
    let cleanup: (() => void) | undefined;

    beforeEach(async () => {
      const made = await make();
      store = made.store;
      cleanup = made.cleanup;
    });
    afterEach(() => cleanup?.());

    it("index + search round-trips: a query returns exactly the docs containing the term", () => {
      store.indexMany("docs", [
        { id: "a", text: "the quick brown fox" },
        { id: "b", text: "a lazy dog sleeps" },
        { id: "c", text: "fox fox fox everywhere" },
      ]);
      const res = store.search("docs", "fox");
      expect(res.map((r) => r.id).sort()).toEqual(["a", "c"]);
    });

    it("a query with no matching docs returns []", () => {
      store.index("docs", { id: "a", text: "hello world" });
      expect(store.search("docs", "nonexistent")).toEqual([]);
    });

    it("indexes named fields and searches across all fields", () => {
      store.indexMany("pages", [
        { id: "title", fields: { title: "amber lighthouse", body: "plain notes" } },
        { id: "body", fields: { title: "plain notes", body: "amber lighthouse" } },
        { id: "none", fields: { title: "plain notes", body: "quiet harbor" } },
      ]);
      expect(store.search("pages", "amber").map((r) => r.id).sort()).toEqual(["body", "title"]);
    });

    it("treats text shorthand and fields.text as the same single-field schema", () => {
      store.index("docs", { id: "a", text: "ruby alpha" });
      store.index("docs", { id: "b", fields: { text: "ruby beta" } });
      expect(store.search("docs", "ruby").map((r) => r.id).sort()).toEqual(["a", "b"]);
    });

    it("uses query-time fieldWeights so title hits can outrank body hits", () => {
      store.indexMany("pages", [
        { id: "title-hit", fields: { title: "opal alpha", body: "plain beta" } },
        { id: "body-hit", fields: { title: "plain beta", body: "opal alpha" } },
        { id: "f1", fields: { title: "river stone", body: "quiet harbor" } },
        { id: "f2", fields: { title: "forest moss", body: "desert sand" } },
        { id: "f3", fields: { title: "ocean wave", body: "valley mist" } },
      ]);
      const res = store.search("pages", "opal", { fieldWeights: { title: 5, body: 1 } });
      expect(res.map((r) => r.id)).toEqual(["title-hit", "body-hit"]);
      expect(res[0]!.score).toBeGreaterThan(res[1]!.score);
    });

    it("supports odd field names and a literal text field in a fielded schema", () => {
      store.indexMany("pages", [
        {
          id: "text-hit",
          fields: { text: "ruby alpha", "title.with.dot": "plain beta", "emoji 🔥": "warm" },
        },
        {
          id: "dot-hit",
          fields: { text: "plain beta", "title.with.dot": "ruby alpha", "emoji 🔥": "warm" },
        },
        { id: "f1", fields: { text: "river", "title.with.dot": "stone", "emoji 🔥": "warm" } },
        { id: "f2", fields: { text: "forest", "title.with.dot": "moss", "emoji 🔥": "warm" } },
        { id: "f3", fields: { text: "ocean", "title.with.dot": "wave", "emoji 🔥": "warm" } },
      ]);
      const res = store.search("pages", "ruby", {
        fieldWeights: { text: 4, "title.with.dot": 1, "emoji 🔥": 1 },
      });
      expect(res.map((r) => r.id)).toEqual(["text-hit", "dot-hit"]);
    });

    it("rejects documents whose field schema differs from the collection", () => {
      store.index("pages", { id: "a", fields: { title: "one", body: "two" } });
      expect(() => store.index("pages", { id: "b", fields: { title: "one" } })).toThrow(/fields/);
      expect(() => store.index("pages", { id: "c", text: "one" })).toThrow(/fields/);
    });

    it("rejects invalid or unknown fieldWeights", () => {
      store.index("pages", { id: "a", fields: { title: "opal", body: "plain" } });
      expect(() => store.search("pages", "opal", { fieldWeights: { title: -1 } })).toThrow(/weight/);
      expect(() => store.search("pages", "opal", { fieldWeights: { title: Number.NaN } })).toThrow(/weight/);
      expect(() => store.search("pages", "opal", { fieldWeights: { heading: 2 } })).toThrow(/Unknown/);
    });

    it("validates bad fieldWeights even when the collection does not exist", () => {
      expect(() => store.search("missing", "opal", { fieldWeights: { title: -1 } })).toThrow(/weight/);
      expect(store.search("missing", "opal", { fieldWeights: { title: 2 } })).toEqual([]);
    });

    it("updates and removes fielded docs without leaving stale FTS rows", () => {
      store.index("pages", { id: "a", fields: { title: "old moon", body: "quiet body" } });
      store.index("pages", { id: "a", fields: { title: "new sun", body: "quiet body" } });
      expect(store.search("pages", "moon")).toEqual([]);
      expect(store.search("pages", "sun").map((r) => r.id)).toEqual(["a"]);
      expect(store.remove("pages", "a")).toBe(true);
      expect(store.search("pages", "sun")).toEqual([]);
    });

    it("empty/whitespace query returns []", () => {
      store.index("docs", { id: "a", text: "hello world" });
      expect(store.search("docs", "")).toEqual([]);
      expect(store.search("docs", "   ")).toEqual([]);
      expect(store.search("docs", "!!!")).toEqual([]); // no tokens after sanitize
    });

    it("ranks a doc repeating the term above one mentioning it once (same top hit on both backends)", () => {
      store.indexMany("docs", [
        { id: "once", text: "zebra apple pie" },
        { id: "thrice", text: "zebra zebra zebra and more zebra" },
        { id: "none", text: "apple pie tart" },
        // filler docs without the term — keeps zebra rare so bm25 idf is positive
        // and term-frequency drives the ranking (a term in most docs has idf≈0).
        { id: "f1", text: "river mountain" },
        { id: "f2", text: "ocean wave" },
        { id: "f3", text: "forest tree" },
        { id: "f4", text: "desert sand" },
      ]);
      const res = store.search("docs", "zebra");
      expect(res.map((r) => r.id)).toEqual(["thrice", "once"]);
      expect(res[0]!.id).toBe("thrice");
      expect(res[0]!.score).toBeGreaterThan(res[1]!.score);
    });

    it("both backends agree on ranking order across multiple relevance tiers", () => {
      store.indexMany("docs", [
        { id: "low", text: "matcha tea and a cookie" },
        { id: "mid", text: "matcha matcha whisk bowl" },
        { id: "high", text: "matcha matcha matcha matcha ceremony" },
        { id: "none", text: "coffee espresso" },
        // filler — keeps matcha rare (positive idf) so tf drives the ranking.
        { id: "f1", text: "river mountain" },
        { id: "f2", text: "ocean wave" },
        { id: "f3", text: "forest tree" },
        { id: "f4", text: "desert sand" },
        { id: "f5", text: "valley mist" },
      ]);
      const res = store.search("docs", "matcha");
      expect(res.map((r) => r.id)).toEqual(["high", "mid", "low"]);
      expect(res[0]!.score).toBeGreaterThan(res[1]!.score);
      expect(res[1]!.score).toBeGreaterThan(res[2]!.score);
    });

    it("filter narrows results to matching meta only (identically on both backends)", () => {
      store.indexMany("docs", [
        { id: "cat-a", text: "cat naps in sun", meta: { type: "cat" } },
        { id: "dog-a", text: "cat chases dog", meta: { type: "dog" } },
        { id: "cat-b", text: "cat eats food", meta: { type: "cat" } },
      ]);
      const res = store.search("docs", "cat", { filter: { where: { type: "cat" } } });
      expect(res.map((r) => r.id).sort()).toEqual(["cat-a", "cat-b"]);
    });

    it("filter excludes docs with no meta", () => {
      store.indexMany("docs", [
        { id: "has-meta", text: "cat naps", meta: { type: "cat" } },
        { id: "no-meta", text: "cat runs" },
      ]);
      const res = store.search("docs", "cat", { filter: { where: { type: "cat" } } });
      expect(res.map((r) => r.id)).toEqual(["has-meta"]);
    });

    it("meta round-trips on results (defaults to {} when none indexed)", () => {
      store.indexMany("docs", [
        { id: "m", text: "hello world", meta: { tag: "x", nested: { n: 1 } } },
        { id: "n", text: "hello there" },
      ]);
      const res = store.search("docs", "hello");
      const m = res.find((r) => r.id === "m")!;
      expect(m.meta).toEqual({ tag: "x", nested: { n: 1 } });
      const n = res.find((r) => r.id === "n")!;
      expect(n.meta).toEqual({});
    });

    it("limit caps the number of results", () => {
      store.indexMany("docs", [
        { id: "a", text: "sun sun sun" },
        { id: "b", text: "sun sun" },
        { id: "c", text: "sun" },
      ]);
      expect(store.search("docs", "sun", { limit: 2 }).length).toBe(2);
    });

    it("default limit is 10", () => {
      const docs = Array.from({ length: 12 }, (_, i) => ({ id: `d${i}`, text: "leaf" }));
      store.indexMany("docs", docs);
      expect(store.search("docs", "leaf").length).toBe(10);
    });

    it("remove drops a doc from subsequent results", () => {
      store.indexMany("docs", [
        { id: "a", text: "river flows" },
        { id: "b", text: "river river wide" },
      ]);
      expect(store.remove("docs", "b")).toBe(true);
      expect(store.remove("docs", "b")).toBe(false);
      const res = store.search("docs", "river");
      expect(res.map((r) => r.id)).toEqual(["a"]);
    });

    it("index upserts (replaces) by id", () => {
      store.index("docs", { id: "a", text: "old moon" });
      store.index("docs", { id: "a", text: "sun sun sun" });
      expect(store.search("docs", "moon")).toEqual([]);
      const res = store.search("docs", "sun");
      expect(res.map((r) => r.id)).toEqual(["a"]);
    });

    it("per-collection isolation — a query in A never returns B's docs", () => {
      store.index("A", { id: "a1", text: "stone" });
      store.index("B", { id: "b1", text: "stone" });
      expect(store.search("A", "stone").map((r) => r.id)).toEqual(["a1"]);
    });

    it("search on an empty collection returns []", () => {
      expect(store.search("nope", "anything")).toEqual([]);
    });

    it("breaks score ties deterministically by id", () => {
      // Identical text → identical score → id tiebreak, NOT insertion order.
      store.indexMany("docs", [
        { id: "c", text: "pebble pebble" },
        { id: "a", text: "pebble pebble" },
        { id: "b", text: "pebble pebble" },
      ]);
      const ids = store.search("docs", "pebble").map((r) => r.id);
      expect(ids).toEqual(["a", "b", "c"]);
    });

    it("sanitizes a query with punctuation/operators instead of throwing", () => {
      store.index("docs", { id: "a", text: "shell scripting" });
      expect(store.search("docs", 'shell "OR" scripting;').map((r) => r.id).sort()).toEqual([
        "a",
      ]);
    });
  });
}

suite("InMemorySearchStore", async () => ({
  store: new InMemorySearchStore(),
}));

suite("SqliteAdapter.search (in-memory db)", async () => {
  const adapter = new SqliteAdapter({ path: ":memory:" });
  return { store: adapter.search, cleanup: () => adapter.close() };
});

describe("SqliteAdapter.search — persistence", () => {
  it("indexed docs survive a close + reopen", () => {
    const path = join(tmpdir(), `mirk-fts-test-${process.pid}-${Date.now()}.db`);
    try {
      const a = new SqliteAdapter({ path });
      a.search.index("docs", { id: "x", text: "persisted text", meta: { k: 1 } });
      a.close();

      const b = new SqliteAdapter({ path });
      const res = b.search.search("docs", "persisted");
      expect(res.map((r) => r.id)).toEqual(["x"]);
      expect(res[0]!.meta).toEqual({ k: 1 });
      b.close();
    } finally {
      rmSync(path, { force: true });
      rmSync(`${path}-wal`, { force: true });
      rmSync(`${path}-shm`, { force: true });
    }
  });

  it("fielded schemas survive a close + reopen", () => {
    const path = join(tmpdir(), `mirk-fielded-fts-test-${process.pid}-${Date.now()}.db`);
    try {
      const a = new SqliteAdapter({ path });
      a.search.index("pages", { id: "x", fields: { title: "ruby guide", body: "plain body" } });
      a.close();

      const b = new SqliteAdapter({ path });
      expect(b.search.search("pages", "ruby", { fieldWeights: { title: 4, body: 1 } }).map((r) => r.id)).toEqual(["x"]);
      expect(() => b.search.index("pages", { id: "bad", text: "ruby" })).toThrow(/fields/);
      b.close();
    } finally {
      rmSync(path, { force: true });
      rmSync(`${path}-wal`, { force: true });
      rmSync(`${path}-shm`, { force: true });
    }
  });

  it("treats pre-schema single-text sqlite FTS tables as the default text schema", () => {
    const path = join(tmpdir(), `mirk-legacy-fts-test-${process.pid}-${Date.now()}.db`);
    const { docs, fts } = searchTableNames("legacy");
    try {
      const db = new Database(path);
      db.exec(`
        CREATE TABLE ${docs} (
          id TEXT PRIMARY KEY,
          text TEXT NOT NULL,
          meta_json TEXT
        );
        CREATE VIRTUAL TABLE ${fts} USING fts5(
          text, content='${docs}', content_rowid='rowid', tokenize='unicode61'
        );
        INSERT INTO ${docs}(id, text, meta_json) VALUES ('old', 'legacy moon', '{"k":2}');
        INSERT INTO ${fts}(${fts}) VALUES('rebuild');
      `);
      db.close();

      const adapter = new SqliteAdapter({ path });
      expect(adapter.search.search("legacy", "moon").map((r) => r.id)).toEqual(["old"]);
      expect(() => adapter.search.index("legacy", { id: "fielded", fields: { title: "moon" } })).toThrow(/fields/);
      adapter.search.index("legacy", { id: "new", text: "legacy sun" });
      expect(adapter.search.search("legacy", "sun").map((r) => r.id)).toEqual(["new"]);
      adapter.close();
    } finally {
      rmSync(path, { force: true });
      rmSync(`${path}-wal`, { force: true });
      rmSync(`${path}-shm`, { force: true });
    }
  });
});

// ── cross-backend ranking parity (the contract the spec names explicitly) ────

describe("search cross-backend ranking parity", () => {
  it("both backends return the SAME ranking order on a clear-relevance fixture", () => {
    const mem = new InMemorySearchStore();
    const adapter = new SqliteAdapter({ path: ":memory:" });
    try {
      const docs = [
        { id: "low", text: "matcha tea and a cookie" },
        { id: "mid", text: "matcha matcha whisk bowl" },
        { id: "high", text: "matcha matcha matcha matcha ceremony" },
        { id: "none", text: "coffee espresso" },
        { id: "f1", text: "river mountain" },
        { id: "f2", text: "ocean wave" },
        { id: "f3", text: "forest tree" },
        { id: "f4", text: "desert sand" },
        { id: "f5", text: "valley mist" },
      ];
      mem.indexMany("docs", docs);
      adapter.search.indexMany("docs", docs);
      const memIds = mem.search("docs", "matcha").map((r) => r.id);
      const sqlIds = adapter.search.search("docs", "matcha").map((r) => r.id);
      expect(memIds).toEqual(sqlIds);
      expect(memIds[0]).toBe("high");
    } finally {
      adapter.close();
    }
  });

  it("both backends return the SAME weighted field ranking order", () => {
    const mem = new InMemorySearchStore();
    const adapter = new SqliteAdapter({ path: ":memory:" });
    try {
      const docs = [
        { id: "title-hit", fields: { title: "opal alpha", body: "plain beta" } },
        { id: "body-hit", fields: { title: "plain beta", body: "opal alpha" } },
        { id: "f1", fields: { title: "river stone", body: "quiet harbor" } },
        { id: "f2", fields: { title: "forest moss", body: "desert sand" } },
        { id: "f3", fields: { title: "ocean wave", body: "valley mist" } },
      ];
      mem.indexMany("pages", docs);
      adapter.search.indexMany("pages", docs);
      const opts = { fieldWeights: { title: 5, body: 1 } };
      const memIds = mem.search("pages", "opal", opts).map((r) => r.id);
      const sqlIds = adapter.search.search("pages", "opal", opts).map((r) => r.id);
      expect(memIds).toEqual(sqlIds);
      expect(memIds).toEqual(["title-hit", "body-hit"]);
    } finally {
      adapter.close();
    }
  });

  it("both backends keep the same weighted order when field lengths are highly skewed", () => {
    const mem = new InMemorySearchStore();
    const adapter = new SqliteAdapter({ path: ":memory:" });
    try {
      const longBody = Array.from({ length: 80 }, (_, i) => `body${i}`).join(" ");
      const longTitle = Array.from({ length: 80 }, (_, i) => `title${i}`).join(" ");
      const docs = [
        { id: "title-short-body-long", fields: { title: "citrine", body: longBody } },
        { id: "title-long-body-short", fields: { title: longTitle, body: "citrine" } },
        { id: "f1", fields: { title: "river stone", body: "quiet harbor" } },
        { id: "f2", fields: { title: "forest moss", body: "desert sand" } },
        { id: "f3", fields: { title: "ocean wave", body: "valley mist" } },
      ];
      mem.indexMany("pages", docs);
      adapter.search.indexMany("pages", docs);
      const opts = { fieldWeights: { title: 6, body: 1 } };
      const memIds = mem.search("pages", "citrine", opts).map((r) => r.id);
      const sqlIds = adapter.search.search("pages", "citrine", opts).map((r) => r.id);
      expect(memIds).toEqual(sqlIds);
      expect(memIds[0]).toBe("title-short-body-long");
    } finally {
      adapter.close();
    }
  });

  it("both backends return the SAME set of matching ids", () => {
    const mem = new InMemorySearchStore();
    const adapter = new SqliteAdapter({ path: ":memory:" });
    try {
      const docs = [
        { id: "a", text: "the quick brown fox" },
        { id: "b", text: "a lazy dog" },
        { id: "c", text: "fox fox fox" },
        { id: "d", text: "brown bear" },
      ];
      mem.indexMany("docs", docs);
      adapter.search.indexMany("docs", docs);
      const memIds = mem.search("docs", "fox brown").map((r) => r.id).sort();
      const sqlIds = adapter.search.search("docs", "fox brown").map((r) => r.id).sort();
      expect(memIds).toEqual(sqlIds);
    } finally {
      adapter.close();
    }
  });
});
