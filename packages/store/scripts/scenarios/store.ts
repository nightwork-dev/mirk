// ─── Scenarios: KV and collection ───────────────────────────────────────────
// The first corpus entries. Each one translates a behavior already asserted by
// `src/store.test.ts` (digest-kv section 8, the `[T]` items), so the generated
// expectations are cross-checked by an independent unit assertion rather than
// self-certifying.
//
// Behaviors where the two backends disagree today are deliberately absent: a
// divergence is a bug in one backend, not a corpus option, and it gets its
// scenario in the same commit as its fix.

import { defineScenario } from "../../src/conformance/define.js";

const PROJECTS = [
  { id: "p1", name: "alpha", category: "ai", priority: 1, pinned: true },
  { id: "p2", name: "bravo", category: "ai", priority: 2, pinned: false },
  { id: "p3", name: "charlie", category: "web", priority: 3, pinned: true },
  { id: "p4", name: "delta", category: "web", priority: 4, pinned: true },
  { id: "p5", name: "echo", category: "ops", priority: 5, pinned: false },
];

const seedProjects = PROJECTS.map((item) => ({
  op: "put",
  args: ["projects", item] as unknown[],
}));

const BULK = Array.from({ length: 10 }, (_, i) => ({
  id: `item-${i}`,
  index: i,
  label: `label ${i}`,
}));

export const scenarios = [
  // ── KV ──────────────────────────────────────────────────────────────────
  defineScenario({
    id: "store/kv-get-missing",
    title: "get on an empty store returns null",
    ports: ["kv"],
    steps: [{ op: "get", args: ["nonexistent"], expect: { value: true } }],
  }),

  defineScenario({
    id: "store/kv-set-get-string",
    title: "a string value round-trips through set and get",
    ports: ["kv"],
    steps: [
      { op: "set", args: ["greeting", "hello"] },
      { op: "get", args: ["greeting"], expect: { value: true } },
    ],
  }),

  defineScenario({
    id: "store/kv-set-get-object",
    title: "a nested object value round-trips through set and get",
    ports: ["kv"],
    steps: [
      { op: "set", args: ["obj", { name: "mirk", count: 3, nested: { ok: true } }] },
      { op: "get", args: ["obj"], expect: { value: true } },
    ],
  }),

  defineScenario({
    id: "store/kv-set-overwrites",
    title: "set on an existing key overwrites the previous value",
    ports: ["kv"],
    steps: [
      { op: "set", args: ["key", "first"] },
      { op: "set", args: ["key", "second"] },
      { op: "get", args: ["key"], expect: { value: true } },
    ],
  }),

  defineScenario({
    id: "store/kv-has-missing",
    title: "has is false for a key that was never set",
    ports: ["kv"],
    steps: [{ op: "has", args: ["ghost"], expect: { value: true } }],
  }),

  defineScenario({
    id: "store/kv-has-present",
    title: "has is true for a key that was set",
    ports: ["kv"],
    steps: [
      { op: "set", args: ["present", 1] },
      { op: "has", args: ["present"], expect: { value: true } },
    ],
  }),

  defineScenario({
    id: "store/kv-delete-missing",
    title: "delete returns false for a key that was never set",
    ports: ["kv"],
    steps: [{ op: "delete", args: ["ghost"], expect: { value: true } }],
  }),

  defineScenario({
    id: "store/kv-delete-existing",
    title: "delete returns true for an existing key and get is null afterwards",
    ports: ["kv"],
    steps: [
      { op: "set", args: ["doomed", "value"] },
      { op: "delete", args: ["doomed"], expect: { value: true } },
      { op: "get", args: ["doomed"], expect: { value: true } },
      { op: "has", args: ["doomed"], expect: { value: true } },
    ],
  }),

  defineScenario({
    id: "store/kv-keys-all",
    title: "keys with no prefix returns every key",
    ports: ["kv"],
    // Inserted out of order on purpose: the returned order is the ruling (code
    // point ascending), not the insertion order the Map happens to keep.
    steps: [
      { op: "set", args: ["gamma", 3] },
      { op: "set", args: ["alpha", 1] },
      { op: "set", args: ["beta", 2] },
      { op: "keys", args: [], expect: { value: true } },
    ],
  }),

  defineScenario({
    id: "store/kv-keys-prefix",
    title: "keys with a prefix returns only the keys under that prefix",
    ports: ["kv"],
    steps: [
      { op: "set", args: ["ns:alpha", 1] },
      { op: "set", args: ["ns:beta", 2] },
      { op: "set", args: ["other:gamma", 3] },
      { op: "keys", args: ["ns:"], expect: { value: true } },
    ],
  }),

  defineScenario({
    id: "store/kv-keys-prefix-is-literal",
    title: "an underscore in a key prefix is literal, not a LIKE wildcard",
    ports: ["kv"],
    steps: [
      { op: "set", args: ["a_b", 1] },
      { op: "set", args: ["axb", 2] },
      { op: "set", args: ["a_c", 3] },
      { op: "keys", args: ["a_"], expect: { value: true } },
    ],
  }),

  // ── Collections ─────────────────────────────────────────────────────────
  defineScenario({
    id: "store/collection-list-all",
    title: "list with no filter returns every item in insertion order",
    ports: ["collection"],
    steps: [...seedProjects, { op: "list", args: ["projects"], expect: { value: true } }],
  }),

  defineScenario({
    id: "store/collection-get-by-id",
    title: "getById returns the item stored under that id",
    ports: ["collection"],
    steps: [...seedProjects, { op: "getById", args: ["projects", "p2"], expect: { value: true } }],
  }),

  defineScenario({
    id: "store/collection-get-by-id-missing",
    title: "getById returns null for an id that was never put",
    ports: ["collection"],
    steps: [
      ...seedProjects,
      { op: "getById", args: ["projects", "nope"], expect: { value: true } },
    ],
  }),

  defineScenario({
    id: "store/collection-put-returns-item",
    title: "put returns the item it was given and getById reads it back",
    ports: ["collection"],
    steps: [
      {
        op: "put",
        args: ["projects", { id: "p6", name: "foxtrot", category: "ai", priority: 6 }],
        expect: { value: true },
      },
      { op: "getById", args: ["projects", "p6"], expect: { value: true } },
    ],
  }),

  defineScenario({
    id: "store/collection-put-replaces",
    title: "put on an existing id replaces the stored fields",
    ports: ["collection"],
    steps: [
      ...seedProjects,
      { op: "put", args: ["projects", { id: "p1", name: "alpha", category: "ai", priority: 0 }] },
      { op: "getById", args: ["projects", "p1"], expect: { value: true } },
      { op: "count", args: ["projects"], expect: { value: true } },
    ],
  }),

  defineScenario({
    id: "store/collection-remove-existing",
    title: "remove returns true for an existing item and getById is null afterwards",
    ports: ["collection"],
    steps: [
      ...seedProjects,
      { op: "remove", args: ["projects", "p3"], expect: { value: true } },
      { op: "getById", args: ["projects", "p3"], expect: { value: true } },
      { op: "count", args: ["projects"], expect: { value: true } },
    ],
  }),

  defineScenario({
    id: "store/collection-remove-missing",
    title: "remove returns false for an id that was never put",
    ports: ["collection"],
    steps: [...seedProjects, { op: "remove", args: ["projects", "nope"], expect: { value: true } }],
  }),

  defineScenario({
    id: "store/collection-count-all",
    title: "count with no filter is the number of items in the collection",
    ports: ["collection"],
    steps: [...seedProjects, { op: "count", args: ["projects"], expect: { value: true } }],
  }),

  defineScenario({
    id: "store/collection-count-unused",
    title: "count on a collection that was never written is zero",
    ports: ["collection"],
    steps: [{ op: "count", args: ["never-used"], expect: { value: true } }],
  }),

  defineScenario({
    id: "store/collection-list-unused",
    title: "list on a collection that was never written is empty",
    ports: ["collection"],
    steps: [{ op: "list", args: ["never-used"], expect: { value: true } }],
  }),

  defineScenario({
    id: "store/collection-nested-json-roundtrip",
    title: "a deeply nested item body round-trips exactly",
    ports: ["collection"],
    steps: [
      {
        op: "put",
        args: [
          "docs",
          {
            id: "d1",
            nested: { deep: { value: [1, 2, 3] } },
            tags: ["a", "b"],
            flag: false,
            empty: null,
          },
        ],
      },
      { op: "getById", args: ["docs", "d1"], expect: { value: true } },
    ],
  }),

  defineScenario({
    id: "store/collection-bulk-roundtrip",
    title: "many items put in one collection all read back by id",
    ports: ["collection"],
    steps: [
      ...BULK.map((item) => ({ op: "put", args: ["bulk", item] as unknown[] })),
      { op: "count", args: ["bulk"], expect: { value: true } },
      { op: "getById", args: ["bulk", "item-0"], expect: { value: true } },
      { op: "getById", args: ["bulk", "item-4"], expect: { value: true } },
      { op: "getById", args: ["bulk", "item-9"], expect: { value: true } },
      { op: "list", args: ["bulk"], expect: { value: true } },
    ],
  }),

  defineScenario({
    id: "store/collection-names-do-not-alias",
    title: "collection names that sanitize alike stay physically distinct",
    ports: ["collection"],
    steps: [
      { op: "put", args: ["foo-bar", { id: "x", v: 1 }] },
      { op: "put", args: ["foo_bar", { id: "x", v: 2 }] },
      { op: "getById", args: ["foo-bar", "x"], expect: { value: true } },
      { op: "getById", args: ["foo_bar", "x"], expect: { value: true } },
      { op: "count", args: ["foo-bar"], expect: { value: true } },
      { op: "count", args: ["foo_bar"], expect: { value: true } },
    ],
  }),

  // ── KV: rulings and previously untested contract ────────────────────────
  defineScenario({
    id: "store/kv-keys-code-point-order",
    title: "keys returns code point ascending order, not insertion order",
    ports: ["kv"],
    steps: [
      { op: "set", args: ["B", 1] },
      { op: "set", args: ["a", 2] },
      { op: "set", args: ["Z", 3] },
      { op: "set", args: ["ä", 4] },
      { op: "keys", args: [], expect: { value: true } },
    ],
  }),

  defineScenario({
    id: "store/kv-keys-astral-code-point-order",
    title: "an astral key sorts after U+FFFD, which UTF-16 code unit order reverses",
    ports: ["kv"],
    // U+1F525 is the surrogate pair D83D DD25. Compared as UTF-16 code units it
    // sorts BEFORE U+FFFD (D83D < FFFD); compared as code points, or as the UTF-8
    // bytes SQLite's BINARY collation uses, it sorts after.
    steps: [
      { op: "set", args: ["\u{1F525}", 1] },
      { op: "set", args: ["�", 2] },
      { op: "keys", args: [], expect: { value: true } },
    ],
  }),

  defineScenario({
    id: "store/kv-set-null-stores-a-value",
    title: "set of null stores a value: has is true and get is null",
    ports: ["kv"],
    steps: [
      { op: "set", args: ["nulled", null] },
      { op: "has", args: ["nulled"], expect: { value: true } },
      { op: "get", args: ["nulled"], expect: { value: true } },
      { op: "get", args: ["never-set"], expect: { value: true } },
      { op: "keys", args: [], expect: { value: true } },
    ],
  }),

  defineScenario({
    id: "store/kv-keys-empty-prefix",
    title: "an empty prefix behaves like no prefix at all",
    ports: ["kv"],
    steps: [
      { op: "set", args: ["b", 1] },
      { op: "set", args: ["a", 2] },
      { op: "keys", args: [""], expect: { value: true } },
    ],
  }),

  defineScenario({
    id: "store/kv-keys-unicode-prefix",
    title: "a prefix matches keys carrying non-ASCII characters",
    ports: ["kv"],
    steps: [
      { op: "set", args: ["emoji-\u{1F525}", 1] },
      { op: "set", args: ["emoji-water", 2] },
      { op: "set", args: ["other", 3] },
      { op: "keys", args: ["emoji-"], expect: { value: true } },
    ],
  }),

  defineScenario({
    id: "store/kv-empty-key",
    title: "the empty string is a valid, addressable key",
    ports: ["kv"],
    steps: [
      { op: "set", args: ["", "root"] },
      { op: "has", args: [""], expect: { value: true } },
      { op: "get", args: [""], expect: { value: true } },
      { op: "keys", args: [], expect: { value: true } },
    ],
  }),

  defineScenario({
    id: "store/kv-mixed-array-roundtrip",
    title: "an array of mixed scalars, objects, nulls and arrays round-trips exactly",
    ports: ["kv"],
    steps: [
      {
        op: "set",
        args: ["mixed", [1, "two", null, true, { a: [false, null] }, [], {}]],
      },
      { op: "get", args: ["mixed"], expect: { value: true } },
    ],
  }),

  // ── Collections: insertion order and identity ───────────────────────────
  defineScenario({
    id: "store/collection-default-order-is-insertion",
    title: "list with no sortBy returns items in the order they were put",
    ports: ["collection"],
    steps: [
      { op: "put", args: ["items", { id: "c" }] },
      { op: "put", args: ["items", { id: "a" }] },
      { op: "put", args: ["items", { id: "b" }] },
      { op: "list", args: ["items"], expect: { ids: true } },
    ],
  }),

  defineScenario({
    id: "store/collection-reput-keeps-position",
    title: "putting an existing id again updates it in place without moving it",
    ports: ["collection"],
    steps: [
      { op: "put", args: ["items", { id: "a", v: 1 }] },
      { op: "put", args: ["items", { id: "b", v: 2 }] },
      { op: "put", args: ["items", { id: "c", v: 3 }] },
      { op: "put", args: ["items", { id: "a", v: 99 }] },
      { op: "list", args: ["items"], expect: { value: true } },
    ],
  }),

  defineScenario({
    id: "store/collection-remove-then-readd-moves-to-end",
    title: "removing an item and putting it back moves it to the end of list",
    ports: ["collection"],
    steps: [
      { op: "put", args: ["items", { id: "a" }] },
      { op: "put", args: ["items", { id: "b" }] },
      { op: "put", args: ["items", { id: "c" }] },
      { op: "remove", args: ["items", "a"] },
      { op: "put", args: ["items", { id: "a" }] },
      { op: "list", args: ["items"], expect: { ids: true } },
    ],
  }),

  defineScenario({
    id: "store/collection-empty-item-id",
    title: "the empty string is a valid, addressable item id",
    ports: ["collection"],
    steps: [
      { op: "put", args: ["items", { id: "", v: 1 }] },
      { op: "getById", args: ["items", ""], expect: { value: true } },
      { op: "count", args: ["items"], expect: { value: true } },
      { op: "remove", args: ["items", ""], expect: { value: true } },
    ],
  }),

  defineScenario({
    id: "store/collection-empty-name-throws",
    title: "an empty collection name is rejected by every collection operation",
    ports: ["collection"],
    steps: [
      { op: "list", args: [""], expect: { throws: true } },
      { op: "count", args: [""], expect: { throws: true } },
      { op: "getById", args: ["", "x"], expect: { throws: true } },
      { op: "put", args: ["", { id: "x" }], expect: { throws: true } },
      { op: "remove", args: ["", "x"], expect: { throws: true } },
    ],
  }),

  defineScenario({
    id: "store/collection-sort-by-astral-id",
    title: "sorting by id puts U+FFFD before an astral character",
    ports: ["collection"],
    steps: [
      { op: "put", args: ["items", { id: "\u{1F525}" }] },
      { op: "put", args: ["items", { id: "�" }] },
      { op: "list", args: ["items", { sortBy: "id" }], expect: { ids: true } },
    ],
  }),

  // ── where ───────────────────────────────────────────────────────────────
  defineScenario({
    id: "store/where-number-and-string-do-not-cross-match",
    title: "a numeric where value never matches the same digits stored as text",
    ports: ["collection"],
    steps: [
      { op: "put", args: ["items", { id: "n", v: 1 }] },
      { op: "put", args: ["items", { id: "s", v: "1" }] },
      { op: "list", args: ["items", { where: { v: 1 } }], expect: { ids: true } },
      { op: "list", args: ["items", { where: { v: "1" } }], expect: { ids: true } },
    ],
  }),

  defineScenario({
    id: "store/where-empty-object-is-a-no-op",
    title: "an empty where clause filters nothing out",
    ports: ["collection"],
    steps: [
      { op: "put", args: ["items", { id: "a" }] },
      { op: "put", args: ["items", { id: "b" }] },
      { op: "list", args: ["items", { where: {} }], expect: { ids: true } },
      { op: "count", args: ["items", { where: {} }], expect: { value: true } },
    ],
  }),

  defineScenario({
    id: "store/where-boolean-is-not-a-number",
    title: "where distinguishes true from 1 and false from 0 in the same field",
    ports: ["collection"],
    steps: [
      { op: "put", args: ["items", { id: "true", v: true }] },
      { op: "put", args: ["items", { id: "one", v: 1 }] },
      { op: "put", args: ["items", { id: "false", v: false }] },
      { op: "put", args: ["items", { id: "zero", v: 0 }] },
      { op: "list", args: ["items", { where: { v: true } }], expect: { ids: true } },
      { op: "list", args: ["items", { where: { v: 1 } }], expect: { ids: true } },
      { op: "list", args: ["items", { where: { v: false } }], expect: { ids: true } },
      { op: "list", args: ["items", { where: { v: 0 } }], expect: { ids: true } },
      { op: "count", args: ["items", { where: { v: true } }], expect: { value: true } },
    ],
  }),

  defineScenario({
    id: "store/where-non-scalar-value-throws",
    title: "an object or array where value is rejected, not treated as no match",
    ports: ["collection"],
    steps: [
      { op: "put", args: ["items", { id: "a", v: { x: 1 } }] },
      { op: "list", args: ["items", { where: { v: { x: 1 } } }], expect: { throws: true } },
      { op: "list", args: ["items", { where: { v: [1, 2] } }], expect: { throws: true } },
      { op: "count", args: ["items", { where: { v: { x: 1 } } }], expect: { throws: true } },
    ],
  }),

  defineScenario({
    id: "store/where-null-matches-explicit-null-only",
    title: "where null matches a stored null and never a missing field",
    ports: ["collection"],
    steps: [
      { op: "put", args: ["items", { id: "explicit", x: null }] },
      { op: "put", args: ["items", { id: "missing" }] },
      { op: "put", args: ["items", { id: "valued", x: 5 }] },
      { op: "list", args: ["items", { where: { x: null } }], expect: { ids: true } },
      { op: "count", args: ["items", { where: { x: null } }], expect: { value: true } },
    ],
  }),

  defineScenario({
    id: "store/where-dotted-name-is-one-top-level-key",
    title: "a dotted where field is one literal top-level key, never a nested path",
    ports: ["collection"],
    steps: [
      { op: "put", args: ["items", { id: "flat", "a.b": 1 }] },
      { op: "put", args: ["items", { id: "nested", a: { b: 1 } }] },
      { op: "list", args: ["items", { where: { "a.b": 1 } }], expect: { ids: true } },
    ],
  }),

  // ── sortBy / sortDir ────────────────────────────────────────────────────
  defineScenario({
    id: "store/sort-ties-keep-insertion-order",
    title: "items with equal sort values stay in the order they were put",
    ports: ["collection"],
    steps: [
      { op: "put", args: ["items", { id: "c", n: 1 }] },
      { op: "put", args: ["items", { id: "a", n: 1 }] },
      { op: "put", args: ["items", { id: "b", n: 1 }] },
      { op: "list", args: ["items", { sortBy: "n" }], expect: { ids: true } },
      { op: "list", args: ["items", { sortBy: "n", sortDir: "desc" }], expect: { ids: true } },
    ],
  }),

  defineScenario({
    id: "store/sort-strings-are-case-sensitive",
    title: "string sorting is by code point, so every uppercase letter precedes lowercase",
    ports: ["collection"],
    steps: [
      { op: "put", args: ["items", { id: "1", s: "b" }] },
      { op: "put", args: ["items", { id: "2", s: "A" }] },
      { op: "put", args: ["items", { id: "3", s: "a" }] },
      { op: "put", args: ["items", { id: "4", s: "B" }] },
      { op: "list", args: ["items", { sortBy: "s" }], expect: { ids: true } },
    ],
  }),

  defineScenario({
    id: "store/sort-booleans-false-before-true",
    title: "false sorts before true",
    ports: ["collection"],
    steps: [
      { op: "put", args: ["items", { id: "t", v: true }] },
      { op: "put", args: ["items", { id: "f", v: false }] },
      { op: "list", args: ["items", { sortBy: "v" }], expect: { ids: true } },
      { op: "list", args: ["items", { sortBy: "v", sortDir: "desc" }], expect: { ids: true } },
    ],
  }),

  defineScenario({
    id: "store/sort-zero-before-null",
    title: "zero is a value and sorts before an explicit null",
    ports: ["collection"],
    steps: [
      { op: "put", args: ["items", { id: "zero", n: 0 }] },
      { op: "put", args: ["items", { id: "null", n: null }] },
      { op: "put", args: ["items", { id: "negative", n: -1 }] },
      { op: "list", args: ["items", { sortBy: "n" }], expect: { ids: true } },
    ],
  }),

  defineScenario({
    id: "store/sort-nulls-and-missing-last-in-both-directions",
    title: "null and missing sort values land last ascending and descending",
    ports: ["collection"],
    steps: [
      { op: "put", args: ["items", { id: "two", n: 2 }] },
      { op: "put", args: ["items", { id: "missing" }] },
      { op: "put", args: ["items", { id: "one", n: 1 }] },
      { op: "put", args: ["items", { id: "null", n: null }] },
      { op: "list", args: ["items", { sortBy: "n" }], expect: { ids: true } },
      { op: "list", args: ["items", { sortBy: "n", sortDir: "desc" }], expect: { ids: true } },
    ],
  }),

  // ── limit / offset ──────────────────────────────────────────────────────
  defineScenario({
    id: "store/limit-zero-returns-nothing",
    title: "a limit of zero returns no rows",
    ports: ["collection"],
    steps: [...seedProjects, { op: "list", args: ["projects", { limit: 0 }], expect: { ids: true } }],
  }),

  defineScenario({
    id: "store/limit-fractional-truncates",
    title: "a fractional limit truncates toward zero",
    ports: ["collection"],
    steps: [
      ...seedProjects,
      { op: "list", args: ["projects", { limit: 1.9 }], expect: { ids: true } },
    ],
  }),

  defineScenario({
    id: "store/limit-negative-returns-nothing",
    title: "a negative limit clamps to zero rather than meaning no limit",
    ports: ["collection"],
    steps: [
      ...seedProjects,
      { op: "list", args: ["projects", { limit: -1 }], expect: { ids: true } },
    ],
  }),

  defineScenario({
    id: "store/offset-negative-is-zero",
    title: "a negative offset is treated as no offset",
    ports: ["collection"],
    steps: [
      ...seedProjects,
      { op: "list", args: ["projects", { offset: -2 }], expect: { ids: true } },
    ],
  }),

  defineScenario({
    id: "store/offset-past-the-end-is-empty",
    title: "an offset beyond the last row returns nothing",
    ports: ["collection"],
    steps: [
      ...seedProjects,
      { op: "list", args: ["projects", { offset: 99 }], expect: { ids: true } },
    ],
  }),

  defineScenario({
    id: "store/offset-without-limit-returns-the-tail",
    title: "an offset with no limit returns every row after the offset",
    ports: ["collection"],
    steps: [
      ...seedProjects,
      { op: "list", args: ["projects", { offset: 3 }], expect: { ids: true } },
    ],
  }),

  defineScenario({
    id: "store/offset-then-limit-applied-after-sort",
    title: "offset and limit page a sorted result, not the insertion order",
    ports: ["collection"],
    steps: [
      ...seedProjects,
      {
        op: "list",
        args: ["projects", { sortBy: "priority", sortDir: "desc", offset: 1, limit: 2 }],
        expect: { ids: true },
      },
    ],
  }),

  defineScenario({
    id: "store/count-ignores-sort-limit-and-offset",
    title: "count answers how many match the where clause and ignores paging",
    ports: ["collection"],
    steps: [
      { op: "put", args: ["items", { id: "a", k: 1 }] },
      { op: "put", args: ["items", { id: "b", k: 1 }] },
      { op: "put", args: ["items", { id: "c", k: 1 }] },
      { op: "put", args: ["items", { id: "d", k: 2 }] },
      {
        op: "count",
        args: ["items", { where: { k: 1 }, sortBy: "id", limit: 1, offset: 1 }],
        expect: { value: true },
      },
      { op: "count", args: ["items", { limit: 1 }], expect: { value: true } },
    ],
  }),

  // ── listWhereIn ─────────────────────────────────────────────────────────
  defineScenario({
    id: "store/list-where-in-empty-values",
    title: "an empty values list returns nothing without querying",
    ports: ["collection"],
    capabilities: ["listWhereIn"],
    steps: [
      { op: "put", args: ["items", { id: "a", f: "x" }] },
      { op: "listWhereIn", args: ["items", "f", []], expect: { ids: true } },
    ],
  }),

  defineScenario({
    id: "store/list-where-in-explicit-null",
    title: "null among the values matches a stored null and never a missing field",
    ports: ["collection"],
    capabilities: ["listWhereIn"],
    steps: [
      { op: "put", args: ["items", { id: "explicit", f: null }] },
      { op: "put", args: ["items", { id: "missing" }] },
      { op: "put", args: ["items", { id: "valued", f: 1 }] },
      { op: "listWhereIn", args: ["items", "f", [null]], expect: { ids: true } },
    ],
  }),

  defineScenario({
    id: "store/list-where-in-does-not-cross-match-types",
    title: "a numeric value never matches the same digits stored as text",
    ports: ["collection"],
    capabilities: ["listWhereIn"],
    steps: [
      { op: "put", args: ["items", { id: "n", f: 1 }] },
      { op: "put", args: ["items", { id: "s", f: "1" }] },
      { op: "listWhereIn", args: ["items", "f", [1]], expect: { ids: true } },
      { op: "listWhereIn", args: ["items", "f", ["1"]], expect: { ids: true } },
    ],
  }),

  defineScenario({
    id: "store/list-where-in-booleans",
    title: "boolean values match boolean fields",
    ports: ["collection"],
    capabilities: ["listWhereIn"],
    steps: [
      { op: "put", args: ["items", { id: "t", f: true }] },
      { op: "put", args: ["items", { id: "f", f: false }] },
      { op: "listWhereIn", args: ["items", "f", [true]], expect: { ids: true } },
      { op: "listWhereIn", args: ["items", "f", [false]], expect: { ids: true } },
    ],
  }),

  defineScenario({
    id: "store/list-where-in-duplicate-values",
    title: "a repeated value does not duplicate the row it matches",
    ports: ["collection"],
    capabilities: ["listWhereIn"],
    steps: [
      { op: "put", args: ["items", { id: "a", f: "x" }] },
      { op: "put", args: ["items", { id: "b", f: "y" }] },
      { op: "listWhereIn", args: ["items", "f", ["x", "x", "y"]], expect: { ids: true } },
    ],
  }),

  defineScenario({
    id: "store/list-where-in-where-on-same-field-is-anded",
    title: "a where clause on the IN field narrows the IN rather than replacing it",
    ports: ["collection"],
    capabilities: ["listWhereIn"],
    steps: [
      { op: "put", args: ["items", { id: "1", f: "a" }] },
      { op: "put", args: ["items", { id: "2", f: "b" }] },
      { op: "put", args: ["items", { id: "3", f: "c" }] },
      {
        op: "listWhereIn",
        args: ["items", "f", ["a", "b"], { where: { f: "b" } }],
        expect: { ids: true },
      },
    ],
  }),

  defineScenario({
    id: "store/list-where-in-default-order-is-insertion",
    title: "listWhereIn with no sortBy returns matches in insertion order",
    ports: ["collection"],
    capabilities: ["listWhereIn"],
    steps: [
      { op: "put", args: ["items", { id: "c", f: "x" }] },
      { op: "put", args: ["items", { id: "a", f: "x" }] },
      { op: "put", args: ["items", { id: "b", f: "x" }] },
      { op: "listWhereIn", args: ["items", "f", ["x"]], expect: { ids: true } },
    ],
  }),

  defineScenario({
    id: "store/list-where-in-non-scalar-value-throws",
    title: "an object or array among the values is rejected, not treated as no match",
    ports: ["collection"],
    capabilities: ["listWhereIn"],
    steps: [
      { op: "put", args: ["items", { id: "a", f: "x" }] },
      { op: "listWhereIn", args: ["items", "f", [{ a: 1 }]], expect: { throws: true } },
      { op: "listWhereIn", args: ["items", "f", ["x", [1]]], expect: { throws: true } },
    ],
  }),
];
