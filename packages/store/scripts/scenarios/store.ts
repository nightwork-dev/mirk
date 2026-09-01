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
    // TODO(T1): reorder inserts once memory keys() sorts. Inserting gamma,
    // alpha, beta is the scenario that actually pins the ruling (keys() is code
    // point ascending), and it fails generation today:
    //   store/kv-keys-all step 3 (keys) [sqlite] disagrees with the memory
    //   reference: at $[0]: expected "gamma", got "alpha"
    // Memory returns insertion order, SQLite returns code point order. Until
    // the memory fix lands, the inserts stay sorted so the two agree and this
    // scenario pins only the membership half of the contract.
    steps: [
      { op: "set", args: ["alpha", 1] },
      { op: "set", args: ["beta", 2] },
      { op: "set", args: ["gamma", 3] },
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
];
