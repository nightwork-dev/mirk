# `SyncStore` KV + collection port — behavioral semantics digest

Sources: `packages/store/src/types.ts` (port), `packages/store/src/backends/memory.ts`
(reference), `packages/store/src/adapters/sqlite.ts` + `packages/store/src/sql.ts`
(SQLite adapter), `packages/store/src/namespace.ts`, and the tests
`store.test.ts`, `namespace.test.ts`, `sqlite-operations.test.ts`, `graph.test.ts`.

Everything marked **PROBED** was verified by running both backends, not read off the
source. The probe file was temporary and has been removed; the repo is unmodified.

---

## 0. Shape of the port

`SyncStore` (`types.ts:61-87`) is one object with two disjoint namespaces:

- **KV**: `get(key)`, `set(key, value)`, `has(key)`, `delete(key)`, `keys(prefix?)`
- **Collections**: `list(collection, filter?)`, `getById(collection, id)`,
  `put(collection, item)`, `remove(collection, id)`, `count(collection, filter?)`
- `meta.backend` is a free-form backend id string (`"memory"`, `"sqlite"`).

`StoreFilter` (`types.ts:16-27`): `{ where?, sortBy?, sortDir?, limit?, offset? }`.
Optional capability `SyncStoreInQuery.listWhereIn` (`types.ts:33-40`).

KV keys and collection names live in **separate physical spaces**. A key `"x"` and a
collection `"x"` never interact (memory: two Maps, `memory.ts:33,36`; sqlite: `_kv`
table vs a per-collection `c_<sanitized>_<hash>` table, `sqlite.ts:148-174`).

---

## 1. KV semantics

### 1.1 Value encoding

| Value | memory | sqlite | Port contract for a Python port |
| --- | --- | --- | --- |
| `undefined` **PROBED** | `has` true, `get` null | **throws** `NOT NULL constraint failed: _kv.value` | Undefined is not a value. Do not model it. |
| `null` **PROBED** | `has` true, `get` null | `has` true, `get` null | **`get` cannot distinguish stored-null from missing.** `has` is the only existence test. `set(k, None)` STORES, it does not delete. |
| `Date` **PROBED** | returned as a live `Date` object | returned as ISO string `1970-01-01T00:00:00.000Z` | **Divergent.** Only JSON types are in the contract. |
| `NaN` / `Infinity` **PROBED** | `null` | `null` | JSON has no NaN/Inf; both coerce to null. |
| BigInt **PROBED** | survives | **throws** `Do not know how to serialize a BigInt` | Out of contract. |
| `{a:1, b:undefined}` **PROBED** | `{a:1}` | `{a:1}` | Keys with undefined values are dropped. |
| arrays, nested objects, embedded `null` **PROBED** | exact round-trip | exact round-trip | Full JSON round-trip. |
| `9007199254740993` **PROBED** | `9007199254740992` | `9007199254740992` | IEEE-754 double precision on both. Python must clamp to float64 for parity, or accept a documented divergence for large ints. |

Physical encoding: memory keeps the **live JS reference** (`memory.ts:58`); sqlite
stores `JSON.stringify(value)` in a `TEXT NOT NULL` column and `JSON.parse`s on read
(`sqlite.ts` get/set). A Python port should specify JSON as the wire form and deep-copy
on write in the in-memory reference to avoid the memory backend's aliasing (see 2.5).

### 1.2 `keys(prefix)`

- No prefix returns all keys.
- Prefix matching is **literal startsWith**, not a glob. SQLite escapes backslash,
  percent and underscore before a `LIKE ... ESCAPE` (`sqlite.ts:211-227`); the memory
  backend uses `String.startsWith` (`memory.ts:75`). Pinned by the parity test
  `store.test.ts:399-404`: `keys('a_')` must return `['a_b','a_c']`, never `axb`.
- Empty-string prefix behaves like no prefix **PROBED**.
- **ORDERING DIVERGES. PROBED**
  - memory: **insertion order** (Map iteration). Setting `z, a, m` returns `["z","a","m"]`.
  - sqlite: `ORDER BY key`, i.e. **byte-wise / code-unit ascending**. Same input returns
    `["a","m","z"]`; input `B, a, Z, ä` returns `["B","Z","a","ä"]` (uppercase before
    lowercase, non-ASCII last). Memory returns `["B","a","Z","ä"]`.
  - The tests never assert key order: `store.test.ts:95-114` uses `toContain` plus
    length, and the parity test sorts before comparing (`store.test.ts:403`).
  - **Recommendation: treat `keys()` order as UNSPECIFIED and compare as a set, or pin
    byte-ascending (the sqlite behavior) and fix the memory reference.**
- Unicode keys work on both **PROBED**; sqlite orders by UTF-8 bytes, which for BMP
  text matches code-point order.

### 1.3 `delete` / `has`

- `delete` returns true only if the key existed (`store.test.ts:85-93`).
- `has` is a pure existence check, unaffected by the value (`store.test.ts:76-83`).

---

## 2. Collection semantics

### 2.1 Identity

Items are objects with a required top-level `id` string. `put` upserts on `id`
(memory `Map.set(item.id, item)` at `memory.ts:120`; sqlite `INSERT ... ON CONFLICT(id)
DO UPDATE`). The `id` is also stored inside the JSON body, so `where` on `id` and
`sortBy: 'id'` both work.

- Empty-string `id` is accepted and addressable **PROBED**.
- Empty-string **collection name** throws on both **PROBED** (sqlite:
  `Invalid collection name`, `sqlite.ts:149`; memory throws incidentally).
- Distinct collection names never alias, even when they sanitize to the same SQL
  identifier (`foo-bar` vs `foo_bar`), guaranteed by an FNV-1a hash suffix
  (`sql.ts:78-85`, test `store.test.ts:390-397`).

### 2.2 `put` return value

`put` returns the **same object reference it was given** on both backends **PROBED**
(`memory.ts:126`, `sqlite.ts` `return item`). It is not a copy and not a re-read.
A Python port should return the same object it was handed.

### 2.3 Default ordering of `list()` with no `sortBy`

**Insertion order on both backends PROBED**: `["c","a","b"]` for that put order.
Consistent under update and re-insert:

- Updating an existing item **keeps its original position PROBED**
  (`a,b,c` then re-put `a` gives `["a","b","c"]`). SQLite: `ON CONFLICT DO UPDATE`
  keeps the rowid. Memory: `Map.set` on an existing key keeps position.
- Remove-then-re-add **moves the item to the end PROBED**
  (`a,b,c`, remove `a`, put `a` gives `["b","c","a"]`).

This is de facto contract but **not asserted by any test**. A Python port using a dict
gets this for free; a port over a SQL table gets it from rowid order.

### 2.4 `count`

- No filter: total item count (`store.test.ts:171-177`).
- With `where`: respects the where clause (`store.test.ts:281-286`).
- **DIVERGENCE, limit/offset inside count PROBED**: with 3 items,
  `count(t, {limit:1})` is 3 on both, but `count(t, {where:{k:1}, limit:1})` is
  **1 on memory, 3 on sqlite**. Memory routes through the shared `applyFilter` when a
  where is present (`memory.ts:136-141`), which also slices; sqlite only builds the
  WHERE clause. Untested, and a real parity bug.
  **The Python port should specify: `count` ignores `sortBy`, `limit` and `offset`.**

### 2.5 Reference aliasing (memory only)

**PROBED.** In the memory backend, `list()` and `getById()` hand back the **live stored
object**; mutating the returned object mutates the store, and mutating an object after
`put` also mutates the store. SQLite returns a fresh parse each call. This is a
JS-specific hazard. **A Python port should copy on write and on read** (the sqlite
behavior), which is safer and matches the persistent path.

---

## 3. `StoreFilter` semantics

### 3.1 `where`, exact match on ONE top-level key

- Matching is `record[key] === value` in memory (`memory.ts:343-346`) and
  `json_extract(data, '$."key"') = ?` in sqlite (`sql.ts:34-48`).
- **A dotted field name is ONE literal top-level key, never a nested path.**
  `jsonPath()` builds `$."a.b"`, quoting the field (`sql.ts:24-26`). Pinned by
  `store.test.ts:430-437`: a doc with a literal `a.b` key matches; a doc with nested
  `{a:{b:1}}` must NOT.
- **`where: {x: null}` matches an EXPLICIT null, not a missing field.**
  `sql.ts:36-42` uses `json_type(data, path) = 'null'` for exactly this reason.
  Test `store.test.ts:418-428`.
- Multiple keys are ANDed (`store.test.ts:203-209`). Empty `where: {}` is a no-op
  **PROBED** (`sql.ts:29`).
- Numbers and strings do NOT cross-match: `where {v:1}` matches only numeric 1,
  `{v:'1'}` only the string **PROBED**, on both backends.
- **DIVERGENCE, booleans vs 1/0 PROBED**: with `{id:1, v:true}` and `{id:2, v:1}`,
  memory returns `["1"]` for `where {v:true}` and `["2"]` for `where {v:1}`; **sqlite
  returns both for both**, because `json_extract` of JSON true yields SQL 1 and the
  builder binds true to 1 (`sql.ts:44`). Boolean-only filtering is tested
  (`store.test.ts:218-235`) and works; the ambiguity appears only when a collection
  mixes booleans and 0/1 numbers in the same field.
- **Non-scalar where values are out of contract PROBED**: memory returns `[]`
  (reference inequality) for `where {v:{a:1}}` or `where {v:[1,2]}`; sqlite **throws** a
  binding error. There is no deep equality anywhere.
- **`where: {v: undefined}` PROBED**: memory matches items where the field is ABSENT
  (`record[k] !== undefined` is false); sqlite returns `[]`. JS-only wart; Python has no
  undefined, so forbid it.
- Field names are always **bound as parameters**, never interpolated: a field named
  `x') OR 1=1 --` is inert (`store.test.ts:450-462`).

### 3.2 `sortBy` / `sortDir`

- `sortDir` defaults to asc; any value other than `desc` is ascending
  (`memory.ts:363`, `sql.ts:54`).
- **Null and missing sort LAST in BOTH directions.** Memory pushes undefined-or-null to
  the end regardless of direction (`memory.ts:368-369`); sqlite prepends
  `json_extract(...) IS NULL` to the ORDER BY (`sql.ts:56-61`). Pinned by
  `store.test.ts:406-416`.
- `0` sorts as a normal value, before nulls **PROBED** (`-1, 0, null`).
- **Sort is stable, ties keep insertion order PROBED** on both (`c,a,b` all with `n:1`
  gives `["c","a","b"]`). SQLite is stable here only incidentally (rowid scan order); it
  is not a documented SQLite guarantee. **Untested.** A Python port should sort stably
  (Python's `sorted` is stable) and ideally the contract should state an explicit
  tie-break, because currently there is none.
- **String comparison is byte / code-unit and case-sensitive PROBED**: `A, B, a, b` on
  both. No locale collation. `store.test.ts:237-243` only checks that names equal
  `names.sort()`, which is the same JS default comparison.
- **Booleans sort false before true** on both **PROBED**.
- **DIVERGENCE, mixed number/string in one field PROBED**: values `10, "9", 2` sort to
  `[2, "9", 10]` on memory (JS `<` coerces the string) and `[2, 10, "9"]` on sqlite
  (SQLite type ordering puts all numbers before all text). **Do not mix types in a
  sorted field; declare this unspecified.**
- Object and array sort values happen to agree **PROBED**, but accidentally. Treat as
  unspecified.
- A dotted `sortBy` is also one literal top-level key (`store.test.ts:439-448`).

### 3.3 `offset` and `limit`

Order of application on both: **where, then sort, then offset, then limit**
(`memory.ts:349-384`; sqlite composes `WHERE ... ORDER BY ... LIMIT ... OFFSET ...`).

- `limit: 0` gives 0 rows on both **PROBED**.
- `limit: 1.9` gives 1 row on both **PROBED** (sqlite floors; memory's `slice`
  truncates).
- **DIVERGENCE, negative limit PROBED**: `limit: -1` returns **all rows on memory**
  (guarded by `limit >= 0`, `memory.ts:380`) and **0 rows on sqlite**
  (`Math.max(0, ...)`, `sql.ts:67`). Untested. Pick one; sqlite's clamp-to-zero is the
  saner rule for a port.
- Negative `offset` is ignored on both, treated as 0 **PROBED**.
- `offset` past the end returns `[]` on both **PROBED**.
- `offset` without `limit` works on both **PROBED** (sqlite emits `LIMIT -1 OFFSET n`,
  `sql.ts:70`). Test `store.test.ts:259-267`.

---

## 4. `listWhereIn`, the optional `SyncStoreInQuery`

Signature: `listWhereIn(collection, field, values, filter?)` returns items.
Semantics: `field` is in `values`, then the normal `StoreFilter` applies on top.

- **Empty `values` returns `[]` immediately** on both, without touching the store
  (`memory.ts:102`, `sqlite.ts:249`). Asserted for postgres at
  `packages/store-postgres/src/postgres-adapter.test.ts:66`.
- `null` inside `values` matches an **explicit-null** field, not a missing one
  **PROBED** (sqlite emits a separate `json_type(...) = 'null'` OR-branch,
  `sqlite.ts:129-140`).
- Values compare by scalar equality: `[1]` does not match the string `"1"` **PROBED**;
  booleans match booleans **PROBED**.
- **Non-scalar values are out of contract**: memory silently returns `[]` (Set
  identity), sqlite **throws** `Store IN queries only support JSON scalar values.`
  (`sqlite.ts:116-127`) **PROBED**.
- Duplicate values are harmless; each item appears once **PROBED**.
- **`filter.where` on the SAME field is ANDed with the IN, it does not replace it
  PROBED**: `listWhereIn(t,'f',['a','b'],{where:{f:'b'}})` returns only item 2. The
  graph layer relies on the opposite convention and therefore **strips the field from
  the where clause itself** before calling (`graph.ts:82-88` `withoutWhereField`, test
  `graph.test.ts:426-443`; the surreal adapter mirrors this at
  `packages/surreal/src/graph.test.ts:135`).
- Result ordering with no `sortBy` is insertion order on both **PROBED**.

---

## 5. `namespaceStore` (`packages/store/src/namespace.ts`)

A pure decorator over any `SyncStore`. Contract:

- Separator is the **unit separator, code point 001F** (`namespace.ts:14`). Every KV key
  becomes namespace + separator + key; every collection NAME becomes namespace +
  separator + collection. Item ids are untouched (`namespace.ts:24-36,57-71`).
- The namespace must be non-empty and must not itself contain the separator
  (`namespace.ts:16-22`, test `namespace.test.ts:46-54`).
- `keys(p)` queries the backing store with the prefixed form of `p` or the empty string,
  and **strips the prefix from every returned key** (`namespace.ts:52-56`). Callers
  never see the physical prefix (test `namespace.test.ts:33-44`).
- Two namespaces over one backing store isolate identical keys and identical collection
  ids (test `namespace.test.ts:11-31`).
- **Implication for a port**: the namespace layer is pure string prefixing over the
  port. Nothing about it is backend-specific, so implement it once in Python over the
  port, not per backend. Note that `keys()` ordering inherits the backend's ordering
  (see 1.2).
- Atomic-capability namespacing (version-token binding with a NUL-separated prefix) is a
  separate concern layered on top; see section 7.

---

## 6. Documented cross-backend parity rules

- `sql.ts:18-23` — a field name is one top-level JSON key, never a nested path; bound,
  never interpolated, because names are caller-supplied.
- `sql.ts:36-42` — `where` null must match only an explicit JSON null; `= NULL` never
  matches in SQL, hence `json_type`.
- `sql.ts:56-58` — `IS NULL` first in ORDER BY so nulls and missing fields land LAST in
  both directions, "matching the in-memory reference."
- `sqlite.ts:213-215` — LIKE wildcards escaped so the `keys` prefix matches literally,
  "matches the in-memory reference's `key.startsWith(prefix)`."
- `sqlite.ts:151-153` — hash suffix on table names so distinct collections never alias.
- `sql.ts:1-9` — the SQL builders are shared by the better-sqlite3 and libSQL adapters
  precisely so filter semantics cannot drift. `packages/store-postgres` and
  `packages/surreal` implement the same port and should be checked against the same
  corpus.
- `types.ts:52-59` — sync is the base interface; `toAsync` (`to-async.ts:91-103`) lifts
  it and forwards `listWhereIn` and atomic capabilities when present.

---

## 7. Node/JS-specific behavior that will not translate to Python

1. **undefined vs null.** The `get() -> T | null` design collapses absent and
   stored-undefined in memory, and throws in sqlite. Python has only `None`; define
   `get` as returning `None` for both, and make `has` authoritative.
2. **Map insertion order** is the memory backend's `keys()` and `list()` ordering.
   Python dicts preserve insertion order too, so `list()` ports cleanly, but `keys()`
   ordering must be decided deliberately (see 1.2).
3. **Live object references.** Memory stores and returns the caller's object. Python
   should deep-copy, matching the persistent backends.
4. **JS `<` coercion** across types (2 vs "9") drives the memory sort. Python raises
   TypeError comparing int to str, so the port must define an explicit type-rank
   ordering or declare mixed-type sorts unspecified.
5. **`JSON.stringify` drops undefined object properties, turns Date into an ISO string,
   and NaN/Infinity into null.** Python's json raises on NaN only with
   `allow_nan=False`; set that explicitly for parity.
6. **IEEE-754 number precision**: JS has no integer type. Python ints are unbounded, so
   a round-trip of 2**53 + 1 would SURVIVE in Python and is lost in JS.
7. **startsWith and code-unit comparison** are UTF-16 based; Python strings are code
   points. They differ only above the BMP for ordering.
8. **`AtomicMutationRejectedError` and the branded `StoreVersion` type** are
   TypeScript-only and carry no runtime meaning beyond the string.

---

## 8. Conformance corpus: every behavioral assertion to reproduce

Format: setup, operation, expected. `[T]` = asserted by an existing test.
`[P]` = established by probing both backends, currently untested.
`[D]` = backends DIVERGE today; the corpus must pick a winner.

### KV
1. `[T]` empty store, `get("nonexistent")`, null. (`store.test.ts:51`)
2. `[T]` `set("greeting","hello")`, `get`, `"hello"`. (`:56`)
3. `[T]` `set("obj", {name, count, nested:{ok:true}})`, `get`, deep-equal. (`:62`)
4. `[T]` `set("key","first")` then `set("key","second")`, `get`, `"second"`. (`:69`)
5. `[T]` `has("ghost")`, false. (`:76`)
6. `[T]` `set("present",1)`, `has`, true. (`:80`)
7. `[T]` `delete("ghost")`, false. (`:85`)
8. `[T]` set then delete, true, and `get` is null. (`:89`)
9. `[T]` three keys set, `keys()` contains all three, length 3. (`:95`)
10. `[T]` `ns:alpha`, `ns:beta`, `other:gamma`, `keys("ns:")`, exactly the two. (`:106`)
11. `[T]` `a_b`, `axb`, `a_c`, `keys("a_")` sorted, `["a_b","a_c"]`, no LIKE overmatch. (`:399`)
12. `[P]` `set(k, null)`, `has` true and `get` null. Storing null is not a delete.
13. `[P]` `keys("")` behaves as `keys()`.
14. `[P]` unicode key `emoji-fire`, `keys("emoji-")` finds it.
15. `[P]` 2**53 + 1 round-trip gives 9007199254740992 in JS. Decide for Python.
16. `[P][D]` `keys()` ordering: memory insertion, sqlite byte-ascending. Specify, or compare as a set.
17. `[P][D]` `set(k, undefined)`: memory stores-as-null, sqlite throws. Port: forbid.
18. `[P][D]` Date value: memory keeps the object, sqlite returns an ISO string. Port: JSON only.
19. `[P]` NaN and Infinity become null on both.
20. `[P]` `{a:1, b:undefined}` becomes `{a:1}` on both.
21. `[P]` array with mixed scalars, objects and null round-trips exactly.
22. `[P]` empty-string key is valid and addressable.

### Collections
23. `[T]` 5 items put, `list()` length 5. (`:128`)
24. `[T]` `getById("projects","p2")` returns the right item. (`:133`)
25. `[T]` `getById` with a missing id returns null. (`:139`)
26. `[T]` `put` a new item returns it, and `getById` finds it. (`:144`)
27. `[T]` `put` an existing id replaces fields (priority 1 becomes 0). (`:153`)
28. `[T]` `remove` existing returns true, `getById` then null. (`:161`)
29. `[T]` `remove` missing returns false. (`:167`)
30. `[T]` `count()` is 5. (`:171`)
31. `[T]` `count` on a never-used collection is 0. (`:175`)
32. `[T]` `list` on a never-used collection is `[]`. (`:179`)
33. `[T]` nested JSON body `{nested:{deep:{value:[1,2,3]}}, tags:[...]}` round-trips. (`:320`)
34. `[T]` 100 items put, 50 read back by id, all correct. (`:331`)
35. `[T]` `put("foo-bar",{id:"x",v:1})` and `put("foo_bar",{id:"x",v:2})`, both readable, counts 1 and 1. (`:390`)
36. `[P]` `put` returns the SAME object reference it was given.
37. `[P]` default `list()` order is insertion order.
38. `[P]` re-putting an existing id preserves its position in `list()`.
39. `[P]` remove-then-re-add moves the item to the END of `list()`.
40. `[P]` empty-string item id is valid.
41. `[P]` empty collection name throws on both.
42. `[P][D]` memory `list`/`getById` return live references; sqlite returns copies. Port: copies.

### where
43. `[T]` `where {category:'ai'}` gives 2 items, all matching. (`:195`)
44. `[T]` `where {category:'ai', priority:2}` gives exactly 1, an AND. (`:203`)
45. `[T]` `where` with no matches gives `[]`. (`:211`)
46. `[T]` `where {pinned:true}` gives 2; `{pinned:false}` gives 1. (`:218`)
47. `[T]` `count` respects `where`, gives 2. (`:281`)
48. `[T]` `where {x:null}` matches only the explicit-null doc; missing-field and valued docs excluded; `count` agrees at 1. (`:418`)
49. `[T]` doc with literal key `a.b` and doc with nested `{a:{b:1}}`: `where {'a.b':1}` matches ONLY the flat one. (`:430`)
50. `[T]` field name `x') OR 1=1 --` matches only that doc, and `sortBy` on it does not throw. (`:450`)
51. `[P]` `where {v:1}` and `where {v:'1'}` do not cross-match.
52. `[P]` `where {}` is a no-op.
53. `[P][D]` boolean true vs number 1 in the same field: memory distinguishes, sqlite does not. Specify.
54. `[P][D]` non-scalar where value (`{a:1}` or `[1,2]`): memory `[]`, sqlite throws. Port: reject.
55. `[P][D]` `where {v: undefined}`: memory matches missing-field docs, sqlite `[]`. Port: forbid.

### sortBy / sortDir
56. `[T]` `sortBy:'name'` sorts ascending by default. (`:237`)
57. `[T]` `sortBy:'priority', sortDir:'desc'` sorts descending. (`:245`)
58. `[T]` items `{n:2}`, `{}`, `{n:1}`: asc `["3","1","2"]`, desc `["1","3","2"]`, null/missing LAST in both. (`:406`)
59. `[T]` docs with both a literal `a.b` and a nested `a.b`: `sortBy:'a.b'` follows the top-level key, `["y","z","x"]`. (`:439`)
60. `[P]` ties preserve insertion order, a stable sort.
61. `[P]` strings sort case-sensitively by code unit: `["A","B","a","b"]`.
62. `[P]` booleans sort false before true.
63. `[P]` 0 sorts before null and missing, order `-1, 0, null`.
64. `[P][D]` mixed number/string in one field: memory `[2,"9",10]`, sqlite `[2,10,"9"]`. Declare unspecified.
65. `[P]` object and array sort values are unspecified; do not pin them.

### limit / offset
66. `[T]` `limit:2` gives 2 items. (`:254`)
67. `[T]` `sortBy:'name', offset:2` gives 3 items, first equals the full list index 2. (`:259`)
68. `[T]` `sortBy:'name', limit:2, offset:1` gives items at indices 1 and 2. (`:269`)
69. `[P]` `limit:0` gives `[]`.
70. `[P]` fractional `limit:1.9` gives 1 item.
71. `[P]` negative `offset` is treated as 0.
72. `[P]` `offset` past the end gives `[]`.
73. `[P]` `offset` with no `limit` returns the tail.
74. `[P][D]` `limit:-1`: memory returns everything, sqlite returns nothing. Port: clamp to 0.
75. `[P][D]` `count` with `{where, limit:1}`: memory applies the limit and gives 1, sqlite ignores it and gives 3. Port: count ignores sort, limit and offset.

### listWhereIn
76. `[T]` empty `values` gives `[]` without a query. (`packages/store-postgres/src/postgres-adapter.test.ts:66`)
77. `[T]` `listWhereIn` plus a `where` filter combine. (`postgres-adapter.test.ts:65`, `packages/surreal/test/store.test.ts:186`)
78. `[T]` graph traversal pushes `edgeFilter.where` into each call and strips the IN field from it. (`graph.test.ts:426-443`)
79. `[P]` `values:[null]` matches the explicit-null doc only.
80. `[P]` `values:[1]` does not match the string `"1"`.
81. `[P]` `values:[true]` matches booleans.
82. `[P]` duplicate values do not duplicate rows.
83. `[P]` a `where` on the SAME field is ANDed with the IN, not replaced.
84. `[P]` default result order is insertion order.
85. `[P][D]` non-scalar in `values`: memory `[]`, sqlite throws. Port: reject.

### namespaceStore
86. `[T]` two namespaces, same key and same collection id, fully isolated. (`namespace.test.ts:11`)
87. `[T]` `keys()` and `keys("item:")` return namespace-local keys with no physical prefix. (`:33`)
88. `[T]` empty namespace throws; a namespace containing the unit separator throws. (`:46`)

### toAsync, port-level and trivially portable
89. `[T]` a lifted sync store answers set, get, has, put, getById, count and delete, and preserves `meta.backend`. (`store.test.ts:357`)
90. `[T]` writes made directly on the underlying sync store are visible through the async face. (`:371`)

---

## 9. `atomic.ts` and `coordination.ts`, one paragraph each

**`packages/store/src/atomic.ts`, 588 lines, PORTABLE and backend-neutral.**
It defines an optional declarative compare-and-swap capability: `StoreTarget` (a key or
a collection plus id), an opaque branded `StoreVersion` token, `StoreCondition` (missing,
present, or version), a list of set/delete/put/remove operations, and an idempotency key
with a replayable outcome. `validateAtomicRequest` normalizes and rejects malformed
input, and the module computes a canonical JSON serialization plus a **hand-rolled
SHA-256** (`atomic.ts:502`, with its own constant table) specifically so the file stays
dependency-free and importable from browser-facing entry points. Nothing here touches a
backend: it is pure validation, canonicalization, hashing and cloning, and both
`InMemoryStore` and the sqlite facet implement the same decision procedure over it. A
Python port can translate this file close to line for line, with the caveat that the
canonical-JSON and digest rules must match byte for byte or version tokens and
idempotency digests will not interoperate across languages.

**`packages/store/src/coordination.ts`, 620 lines, NOT portable as-is, Node plus SQLite
process machinery.** It is an async critical-section coordinator: `SqliteCoordinator`
implements `runExclusive(key, work)` over a SQLite-backed lease table with fencing
generations, lease renewal on a timer, wait timeouts, abort-signal integration and
ownership-lost detection. It imports better-sqlite3 and `node:crypto`'s `randomUUID`
directly (`coordination.ts:6-7`), leans on an AbortSignal-shaped interface and the JS
event loop for renewal, and its whole point is coordinating **separate OS processes**
sharing one database file. The lease and fencing algorithm is a portable idea, but the
implementation is not part of the KV port and should be treated as a separate,
runtime-specific concern in any Python effort.
