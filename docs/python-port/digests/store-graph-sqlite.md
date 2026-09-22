# Digest: graph primitive + SQLite physical layout (@mirk/store)

Repo: this one. All line cites are `packages/store/src/...`.
Everything below was read from source and, for part B, verified by writing a real
`.sqlite` file with the built adapter and dumping `sqlite_master` plus row contents.

---

# A. Graph primitive

Files: `graph.ts` (343 lines), `graph.test.ts` (631 lines, 31 tests, all passing).

## A.0 Data model

An edge is a *flat collection record* (`graph.ts:21-27`):

```ts
interface Edge { id: string; from: string; to: string; type: string; [field: string]: unknown }
```

There is no edge table, no node table. Edges live in an ordinary store collection and are
read through `AsyncStore.list` / `AsyncStore.listWhereIn`. Nodes exist only as the string ids
appearing in `from`/`to`. Arbitrary extra fields ride along and are **never projected away**
(`graph.test.ts:384-408` asserts the full record round-trips through both `neighbors` and
`traverse`).

`Direction = "out" | "in" | "both"` (`graph.ts:30`). Default is `"out"` everywhere
(`graph.ts:142`, `graph.ts:198`, `graph.ts:296`).

## A.1 Dispatch / capability ladder

Both `traverse` and `traverseFrontierBatched` first check for a native graph capability:

- `hasGraphTraversal(store)` = store has BOTH `canTraverseGraph` and `traverseGraph` functions
  (`graph.ts:93-96`).
- If present AND `store.canTraverseGraph(collection)` returns true, the whole call delegates:
  `return store.traverseGraph(collection, opts)` (`graph.ts:194-196`, `graph.ts:288-290`).
  The generic code does nothing else: no sorting, no dedup, no depth guard. The native
  result is returned verbatim (test `graph.test.ts:465-477` returns an unsorted
  single-element result and expects it unchanged).
- `traverseFrontierBatched` then checks `hasListWhereIn(store)` = `typeof store.listWhereIn === "function"`
  (`graph.ts:89-91`). If absent it delegates to `traverse` (`graph.ts:292-294`).

Ladder order for `traverseFrontierBatched`: native, then `listWhereIn`, then `traverse`
load-once. `neighbors` has NO native path; it always uses `store.list`.

**Python port note:** these are structural/duck-typed checks on the store object. A Python
port should express them as `hasattr`-style capability checks or explicit protocol flags. A
store that is native-capable but not configured for *this* collection must fall through to
the generic path (`graph.test.ts:547-564`, `graph.test.ts:612-630`).

## A.2 `neighbors(store, collection, opts)` returns `Edge[]`

`graph.ts:132-164`. Single hop. Returns a flat array of full edge records, not `{nodes,edges}`.

- `"out"`: `store.list(collection, withWhere(edgeFilter, { from: opts.from }))`
- `"in"`: `store.list(collection, withWhere(edgeFilter, { to: opts.from }))`
- `"both"`: both queries run concurrently (`Promise.all`), concatenated **out-first**, then
  `dedupById` (first-seen wins) (`graph.ts:155-161`).
- Then `filterByTypes(edges, opts.edgeTypes)` in memory (`graph.ts:163`).

`withWhere` (`graph.ts:75-80`) is `{...filter, where: {...filter?.where, ...override}}`. The
structural field is spread LAST, so a caller's `edgeFilter.where.from` is **overridden** by the
traversal's own `from`. Test `graph.test.ts:372-382`: caller passes `where:{from:"zzz"}`,
result is still a's out-edges.

**Ordering: `neighbors` does NOT sort.** It returns whatever order the store returned
(plus the out-then-in concatenation for `"both"`). Tests that check multi-element results
call `.sort()` themselves (`graph.test.ts:158`, `:176`, `:198`, `:381`). Only single-element
expectations are order-asserted. So a Python port is free to return store order here, but must
preserve the out-before-in concatenation and first-seen dedup for `"both"` to match dedup
identity.

`filterByTypes` (`graph.ts:56-60`): no-op when `edgeTypes` is `undefined` **or an empty array**;
otherwise keeps edges whose `type` is in the set. This is in-memory because `StoreFilter.where`
is exact-match only and cannot express `type IN (...)` (documented `graph.ts:53-55`).

`dedupById` (`graph.ts:63-72`): `Set` of ids, first occurrence kept, order preserved.

## A.3 `traverse(store, collection, opts)` returns `{nodes, edges}`

`graph.ts:189-264`. Load-once BFS.

**Depth guard** (`graph.ts:200-202`): `if (!Number.isFinite(depth) || depth <= 0) return {nodes:[], edges:[]}`.
So `0`, negative, `NaN`, `Infinity` all yield empty. Python equivalent: `math.isfinite(depth)`
must be checked, and `Infinity` must NOT mean "unbounded".

**Load**: exactly one store call, `store.list(collection, opts.edgeFilter)` (`graph.ts:205`).
The caller's policy filter is pushed to the store; `edgeTypes` is applied in memory after.

**Adjacency index** (`graph.ts:211-226`), map node to list of edges, insertion-ordered:
- `"out"`: index by `e.from`
- `"in"`: index by `e.to`
- `"both"`: the edge is added under BOTH `e.from` and `e.to`

**BFS** (`graph.ts:231-257`):
```
visited = {start}      # start is pre-seeded: never re-expanded, never in nodes
reached = []           # append-order = discovery order (pre-sort)
traversedEdges = []    # append-order = discovery order (pre-sort)
frontier = [start]
for hop in range(depth):
    if not frontier: break
    next = []
    for node in frontier:
        for edge in adjacency.get(node, []):
            if edge.id not in seenEdgeIds: record edge
            neighbor = edge.to if edge.from == node else edge.from
            if neighbor not in visited: visited.add; reached.append; next.append
    frontier = next
```

Key semantics:
- **`start` is excluded from `nodes`, always.** It is pre-seeded into `visited`. Depth 1 gives
  direct neighbors only.
- **Neighbor resolution is `edge.from === node ? edge.to : edge.from`** for ALL directions,
  including `"in"`. For an `"in"` walk on edge `x -> node`, `edge.from !== node`, so the
  neighbor is `edge.from` = x. Correct. For a **self-loop** (`from === to === node`), the
  ternary takes the first branch and yields `edge.to`, the node itself, which is already
  visited so it is not added (`graph.test.ts:358-370`).
- **Edges are recorded when traversed, even if the neighbor is already visited.** So the
  cycle-closing edge `c -> a` appears in `edges` while `a` never appears in `nodes`
  (`graph.test.ts:265-278`).
- **An edge is recorded at most once** (dedup by id via `seenEdgeIds`). A node enters `next`
  only on first discovery, so no node is expanded twice.
- Cycles terminate because `visited` gates frontier growth. Depth 100 on a 2-cycle returns
  immediately (`graph.test.ts:280-292`).

**Ordering (the parity contract)** (`graph.ts:259-262`):
```js
reached.sort((a,b) => a < b ? -1 : a > b ? 1 : 0);
traversedEdges.sort((a,b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
```
This is JS `<` on strings, which is **UTF-16 code-unit order**: not code-point order and not
locale collation. For BMP-only ascii/latin ids it equals Python's `<` on `str`. It **differs
from Python** for strings containing non-BMP characters (astral plane, e.g. U+1F600): JS
compares surrogate code units (0xD800-0xDFFF) so astral chars sort BEFORE U+E000-U+FFFF, while
Python compares code points and sorts them after. If the conformance corpus contains only
ascii/BMP ids, `sorted(ids)` in Python is exact. To be safe,
`sorted(ids, key=lambda s: s.encode('utf-16-be'))` reproduces JS order exactly.

`nodes` is sorted by node id, `edges` by edge id. The sort is what makes results deterministic
across backings.

## A.4 `traverseFrontierBatched(store, collection, opts)` returns `{nodes, edges}`

`graph.ts:283-343`. Same result contract as `traverse`, different fetch strategy.

Per hop it calls `frontierEdges` (`graph.ts:98-116`):
- `"out"`: `listWhereIn(collection, "from", frontier, withoutWhereField(edgeFilter, "from"))`
- `"in"`: `listWhereIn(collection, "to", frontier, withoutWhereField(edgeFilter, "to"))`
- `"both"`: both queries via `Promise.all`, out-first concat, `dedupById`

**The `where`-override interaction the brief asks about**: here it is *removal*, not overwrite.
`withoutWhereField(filter, field)` (`graph.ts:82-87`) strips a same-named field from the
caller's `where` before passing it down, because the structural constraint is expressed by the
`listWhereIn` field/values pair instead. Net effect matches `neighbors`: **the structural
frontier field always wins over a caller-supplied `where` on `from`/`to`.** Mechanism differs
(delete-then-IN vs spread-override), observable outcome is the same.

Then `filterByTypes` in memory (`graph.ts:309-312`).

Adjacency is re-derived per hop by scanning the fetched edge list against each frontier node
(`graph.ts:315-335`), with the adjacency predicate:
- `"out"`: `edge.from === node`
- `"in"`: `edge.to === node`
- `"both"`: `edge.from === node || edge.to === node`

Same `visited`/`reached`/`seenEdgeIds` bookkeeping, same neighbor ternary, same final sorts
(`graph.ts:339-340`).

The inner loop is `for node in frontier: for edge in fetchedEdges`, so edge-record order within
a hop follows frontier order then fetch order. Since the output is sorted by id, this only
affects which duplicate id wins, and duplicates are identical records anyway.

## A.5 Every behavioral assertion in graph.test.ts, as scenarios

Base fixture (`graph.test.ts:39-46`), collection `"edges"`, all `published:true` except `e_ax`:

```
e_ab a->b follows | e_bc b->c follows | e_ca c->a follows (closes cycle)
e_ad a->d mentions | e_de d->e follows | e_ax a->x follows published=false
node z is isolated
```

### neighbors (`graph.test.ts:147-215`)
1. `from:a`, default out, yields `{e_ab, e_ad, e_ax}` (sorted by the test).
2. `from:a, direction:in` yields exactly `[e_ca]`.
3. `from:a, direction:both` yields `{e_ab, e_ad, e_ax, e_ca}`.
4. `from:a, edgeTypes:["mentions"]` yields `[e_ad]`.
5. `from:a, edgeFilter:{where:{published:true}}` yields `{e_ab, e_ad}` (e_ax pruned at the store).
6. `from:a, edgeTypes:["follows"], edgeFilter:{where:{published:true}}` yields `[e_ab]`.
7. `from:z` (isolated) yields `[]`.
8. (`:372`) `from:a, edgeFilter:{where:{from:"zzz"}}` yields `{e_ab,e_ad,e_ax}`: structural wins.
9. (`:384`) collection `rich`, one edge with `from_type/to_type/weight`: `neighbors` returns the
   record deep-equal to the stored object, and `traverse` depth 1 likewise.

### traverse (`graph.test.ts:217-424`)
10. `start:a, depth:0` yields `{nodes:[], edges:[]}`.
11. `depth:-3` yields empty.
12. `depth:NaN` yields empty; `depth:Infinity` yields empty.
13. `start:a, depth:1` yields nodes `["b","d","x"]`, edges `["e_ab","e_ad","e_ax"]`.
14. `start:a, depth:2` yields nodes `["b","c","d","e","x"]`, edges `["e_ab","e_ad","e_ax","e_bc","e_de"]`.
15. `start:a, depth:3` yields the same nodes; edges gain `e_ca`, giving
    `["e_ab","e_ad","e_ax","e_bc","e_ca","e_de"]`. `a` never enters nodes.
16. tight 2-cycle `p->q`, `q->p`, `start:p, depth:100` yields nodes `["q"]`, edges `["c_pq","c_qp"]`.
17. `start:a, depth:3, direction:in` yields nodes `["b","c"]`, edges `["e_ab","e_bc","e_ca"]`.
18. `start:e, depth:1, direction:both` yields nodes `["d"]`, edges `["e_de"]`.
19. `start:a, depth:5, edgeTypes:["follows"]` yields nodes `["b","c","x"]`, edges
    `["e_ab","e_ax","e_bc","e_ca"]` (d and e unreachable without the mentions edge).
20. `start:a, depth:5, edgeFilter:{where:{published:true}}` yields nodes `["b","c","d","e"]`,
    edges `["e_ab","e_ad","e_bc","e_ca","e_de"]`.
21. `start:z, depth:5` yields `{nodes:[], edges:[]}`.
22. add self-loop `e_aa a->a`, `start:a, depth:3`: nodes exclude `"a"`, edges contain `e_aa`.
23. chain `a->b->c`, `start:b, depth:2, direction:both` yields nodes `["a","c"]`, edges `["e_ab","e_bc"]`.

### traverseFrontierBatched (`graph.test.ts:426-630`)
24. Probe store whose `list()` throws and whose `listWhereIn` records calls. Fixture plus a
    `noise` edge `unrelated -> sink`. `start:a, depth:2, edgeFilter:{where:{published:true}}`
    yields nodes `["b","c","d","e"]`, edges `["e_ab","e_ad","e_bc","e_de"]`. The query log
    asserts fields `["from","from"]`, values `[["a"], ["b","d"]]`, and that every query carried
    `where.published === true`. This pins one query per hop, frontier values in discovery order
    (unsorted at query time), and edgeFilter push-down.
25. **SQLite path** (`:444-463`): real `SqliteAdapter({path:":memory:"})`, fixture plus noise edge,
    `start:a, depth:5, direction:"both", edgeFilter:{where:{published:true}}`. Asserts
    `traverseFrontierBatched(...)` deep-equals `traverse(...)` on the same store.
26. Native store configured for `"native-edges"`: `traverse` delegates, returns the native
    result verbatim, and native `traverseGraph` is called once with the exact options object.
27. Native-only store (no `listWhereIn`): `traverseFrontierBatched` delegates; `list()` throws
    if touched.
28. Native plus `listWhereIn` on a configured collection: native wins, `listWhereInCalls === 0`.
29. Native-capable store, **unconfigured** collection `"flat-edges"`: no native call,
    `listWhereInCalls === 2` (two hops), result matches load-once semantics.
30. Store with neither capability: falls back to `traverse`, `listCalls === 1`, nodes
    `["b","c","d","e","x"]`.
31. Native-capable store, collection `"notes"` holding a record that merely *has* `from`/`to`
    fields: no native delegation (the collection is not configured); generic traversal returns
    nodes `["target"]`, edges `["note-1"]`.

## A.6 How memory/sqlite parity is actually asserted

Be precise here, because the file header comment overstates it. `graph.test.ts` does NOT run
the same scenario against `InMemoryKv` and `SqliteAdapter` and diff the two. What it asserts is:

- Scenario 25 (`graph.test.ts:444-463`) runs both *strategies* (`traverseFrontierBatched` vs
  `traverse`) against **the same SQLite store** and requires deep equality. That is strategy
  parity on sqlite, and it does exercise the sqlite `listWhereIn` SQL path
  (`json_extract(data,?) IN (...)`) and the boolean `where` push-down (`published:true` bound
  as `1`).
- Everything else runs on `toAsync(new InMemoryKv())` or hand-written probe stores.
- Backend-vs-backend parity for the underlying store port lives elsewhere (`store.test.ts`,
  `search.test.ts`, `vector.test.ts`), not in the graph file.

The mechanism that *makes* graph results backend-independent is the explicit terminal sort plus
the fact that the graph module only uses two port operations (`list`, `listWhereIn`) with
exact-match filters.

---

# B. SQLite adapter physical layout

Files: `adapters/sqlite.ts` (1515 lines), `sql.ts`, `vector/cosine.ts`, `search/fields.ts`,
`search/tokenize.ts`.

Everything in this section was verified against a real file written by
`packages/store/dist/adapters/sqlite.js`, then re-opened with a plain read-only
better-sqlite3 connection and dumped from `sqlite_master`. Where a CREATE statement is quoted
it is the observed text, not the source template.

## B.0 Open sequence and pragmas

`SqliteAdapter` constructor (`adapters/sqlite.ts:215-264`):

1. `new Database(path, { timeout: busyTimeoutMs ?? 30_000 })` (driver-level busy timeout).
2. `PRAGMA busy_timeout = <busyTimeoutMs ?? 30000>` (`:231`).
3. Inside a busy-retry wrapper: `PRAGMA journal_mode = WAL` (`:239`), then construct the three
   facets, each of which runs its own bootstrap DDL.
4. `SqliteKvFacet` also runs `PRAGMA foreign_keys = ON` (`:390`).

No other pragmas are set. There is no `synchronous`, `cache_size`, or `mmap_size` setting.

Busy retry (`:865-889`) spins on `SQLITE_BUSY*`/`SQLITE_LOCKED*` until the deadline, sleeping
via `Atomics.wait` in slices of at most 50 ms.

**There is no schema-version table and no migration table.** All DDL is
`CREATE TABLE IF NOT EXISTS`, run on every open. The one migration-shaped thing is the search
facet's implicit upgrade path (B.4). A Python port must therefore tolerate files whose tables
were created by an older adapter build, and should issue the same idempotent DDL.

## B.1 KV table `_kv`

```sql
CREATE TABLE _kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
)
```
(`adapters/sqlite.ts:391-398`)

- **Values are `JSON.stringify(value)` stored as TEXT**, not a blob and not a JSON1 typed
  column (`:477`). Read back with `JSON.parse` (`:467`).
- Write is `INSERT ... ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
  wrapped in a transaction together with a version bump (`:470-480`).
- `created_at`/`updated_at` are SQLite-generated UTC text, format `YYYY-MM-DD HH:MM:SS`.
  Observed: `2026-09-01 23:29:49`. The adapter never reads them back.
- `keys(prefix)` (`:497-513`) escapes `\ % _` in the prefix, then
  `WHERE key LIKE ? ESCAPE '\' ORDER BY key`, binding `prefix + '%'`. Ordering is SQLite's
  BINARY collation on UTF-8 bytes. Without a prefix, `SELECT key FROM _kv ORDER BY key`.
  KV key ordering therefore lives in SQL and is UTF-8 byte order, which equals code-point
  order and can differ from the JS UTF-16 order used by the graph sort.

## B.2 Collections: one table per collection

`tableName(collection)` (`:434-440`):
```
c_<collection with [^a-zA-Z0-9_] replaced by _>_<hashName(collection)>
```
`hashName` (`sql.ts:78-85`) is 32-bit FNV-1a over `charCodeAt` values (UTF-16 code units),
rendered `(h >>> 0).toString(36)`.

Verified in Python against nine real names (`my-coll` gives `zafc9g`, `my_coll` gives `fmg6zy`,
`vc` gives `ji38gu`, `sc` gives `f2l9gz`, `sc2` gives `10nfixf`, `text` gives `1gourem`,
`title` gives `16a95ah`, `body` gives `1oy6jcl`, `edges` gives `ev9wm5`):

```python
def hash_name(s: str) -> str:
    h = 2166136261
    for u in [ord(c) for c in s]:      # BMP-only shortcut; see note below
        h ^= u
        h = (h * 16777619) & 0xFFFFFFFF
    if h == 0:
        return '0'
    digits = '0123456789abcdefghijklmnopqrstuvwxyz'
    out = ''
    while h:
        out = digits[h % 36] + out
        h //= 36
    return out
```
For non-BMP collection names, decompose to UTF-16 code units first
(`struct.unpack(f'<{n}H', s.encode('utf-16-le'))`), because JS `charCodeAt` yields surrogates.

Per-collection table (`:445-452`), observed verbatim:
```sql
CREATE TABLE c_my_coll_zafc9g (
        id TEXT PRIMARY KEY,
        data JSON NOT NULL,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      )
```
`JSON` is not a recognized affinity keyword, so SQLite gives the column NUMERIC affinity, but
the stored value is always a TEXT string so it stays text. There are **no secondary indexes on
collection tables at all**: every filter is a full scan with `json_extract`.

Observed row: `data` = `{"id":"x1","from":"a","to":"b","type":"t","w":1,"flag":true}`, i.e.
plain `JSON.stringify(item)` (`:567`), **insertion key order preserved, not sorted**.

An in-process cache `initializedTables` tracks already-created tables, deliberately not
populated while a transaction is open so an outer rollback cannot leave a stale entry
(`:453-459`, asserted by `sqlite-operations.test.ts:24-45`).

### Where / sortBy / limit / offset: all in SQL

`sql.ts` is shared verbatim with the libsql adapter.

- `buildWhereClause` (`sql.ts:28-50`): each `where` entry becomes `json_extract(data, ?) = ?`
  with the path **bound as a parameter**, never interpolated. The path is `jsonPath(field)` =
  `$."field"` with `"` doubled (`sql.ts:24-26`), so a dotted field name means the literal
  top-level key `a.b`, not a nested path. Booleans bind as `1`/`0` (`sql.ts:44`), which matches
  `json_extract` of a JSON `true`/`false`. An explicit `null` becomes
  `json_type(data, ?) = 'null'`, matching a stored null but not a missing key (`sql.ts:36-42`).
  Conditions are ANDed.
- `buildOrderBy` (`sql.ts:52-62`):
  `ORDER BY json_extract(data, ?) IS NULL, json_extract(data, ?) ASC|DESC`.
  Nulls and missing fields sort LAST in both directions. **The comparison is SQLite's, not
  JS's**, so string ordering is BINARY/UTF-8 byte order and mixed types follow SQLite type
  ordering (NULL, then INTEGER/REAL, then TEXT, then BLOB). This is a real divergence surface
  from the in-memory reference and worth pinning in the conformance corpus.
- `buildLimitOffset` (`sql.ts:64-74`): `LIMIT n` floored at 0; an offset without a limit emits
  `LIMIT -1 OFFSET n`.
- **No default ORDER BY.** Without `sortBy`, `list` returns rows in SQLite scan order, which
  for these tables is rowid order, i.e. insertion order. `id` is the PK and an UPSERT keeps the
  original rowid, so updates do not reorder.
- `count` (`:584-591`) applies `where` only, ignoring `sortBy`/`limit`/`offset`.
- `listWhereIn` (`:529-548`) appends `buildJsonInWhere` (`:129-155`):
  `json_extract(data,?) IN (?,?,...)` for non-null values, ORed with `json_type(data,?)='null'`
  if `null` is among them, joined to any prior WHERE with `AND`. Empty `values` short-circuits
  to `[]` without touching the DB. Only JSON scalars are accepted (`sqlParam`, `:116-127`,
  which throws otherwise and converts booleans to 1/0).

**Answer to "does ordering live in SQL or in code": in SQL for collections.** `where`,
`sortBy`, `limit`, `offset`, and `IN` are all executed by SQLite. The only in-code filtering in
the whole adapter is vector metadata `where`/`whereNot` and search `filter.where`.

## B.3 Atomic-mutation bookkeeping tables

All created by the KV facet (`:399-421`), observed verbatim:

```sql
CREATE TABLE _mirk_atomic_versions (
        kind TEXT NOT NULL, collection TEXT NOT NULL, target_key TEXT NOT NULL,
        version TEXT NOT NULL, PRIMARY KEY (kind, collection, target_key))
CREATE TABLE _mirk_atomic_sequence (id INTEGER PRIMARY KEY CHECK (id = 1), value INTEGER NOT NULL)
CREATE TABLE _mirk_atomic_receipts (idempotency_key TEXT PRIMARY KEY, request_digest TEXT NOT NULL, result_json TEXT NOT NULL)
CREATE TABLE _mirk_atomic_identity (id INTEGER PRIMARY KEY CHECK (id = 1), value TEXT NOT NULL)
```

- `_mirk_atomic_identity` holds ONE `randomUUID()` written with `INSERT OR IGNORE` on first
  open (`:422-431`); every later opener reuses it. It is the version prefix.
- Version strings are `<identity-uuid>-v<sequence>` (`:801`). Observed `...-bd6e-v1`, `-v2`,
  `-v3`. The sequence is a single row incremented with `UPDATE ... SET value = value + 1` and
  then re-read (`:794-800`).
- `kind` is `"key"` (with `collection = ''`) or `"record"` (`:789-792`).
- Every `set`/`put` writes a version row; every `delete`/`remove` deletes it.
- Receipts store `JSON.stringify(appliedResult)`. A replay with the same idempotency key but a
  different `request_digest` returns `idempotency-conflict` (`:630-649`).
- Digests are SHA-256 over `canonicalJson` (`atomic.ts:466-482`), which sorts object keys by
  code point (`atomic.ts:250`), rejects non-finite numbers, sparse arrays, symbol keys, and
  non-plain objects, and serializes numbers with `JSON.stringify` semantics.

## B.4 Search: FTS5

Schema registry (`:1289-1296`), observed:
```sql
CREATE TABLE _mirk_search_schema (collection TEXT PRIMARY KEY, fields_json TEXT NOT NULL)
```
Observed rows: `("sc", "[\"text\"]")` and `("sc2", "[\"body\",\"title\"]")`. Field names are
**sorted** at normalization (`search/fields.ts:20`), so `{title, body}` persists as
`["body","title"]`.

Per collection, two tables plus three triggers:
- docs table `search_docs_<sanitized>_<hashName>` (`:1298-1302`)
- fts table `search_fts_<sanitized>_<hashName>` (`:1304-1308`)

Column naming (`searchColumnName`, `:1260-1263`): the field literally named `text` keeps the
column name `text`; any other field becomes `f<index>_<hashName(field)>`, where `index` is its
position in the sorted field list. Observed for `sc2`: `f0_1oy6jcl` (body), `f1_16a95ah` (title).

Observed DDL:
```sql
CREATE TABLE "search_docs_sc2_10nfixf" (
        id TEXT PRIMARY KEY,
        "f0_1oy6jcl" TEXT NOT NULL,
        "f1_16a95ah" TEXT NOT NULL,
        meta_json TEXT
      )
CREATE VIRTUAL TABLE "search_fts_sc2_10nfixf" USING fts5(
        "f0_1oy6jcl", "f1_16a95ah", content='search_docs_sc2_10nfixf', content_rowid='rowid', tokenize='unicode61'
      )
```
FTS5 external-content mode. Content sync is by **explicit triggers**, not manual maintenance
(`:1393-1412`), observed as `<docs>_ai` (AFTER INSERT), `<docs>_ad` (AFTER DELETE, issuing the
`'delete'` command row), and `<docs>_au` (AFTER UPDATE, delete then insert). The shadow tables
`_config`, `_data`, `_docsize`, `_idx` are FTS5's own.

`tokenize='unicode61'` with default options: no `remove_diacritics` override, no `tokenchars`.

Indexing (`:1418-1449`): `INSERT ... ON CONFLICT(id) DO UPDATE` on the docs table. Missing
field values default to `""`. `meta_json` is `JSON.stringify(doc.meta)` or SQL NULL.

Querying (`:1473-1510`):
```sql
SELECT d.id, d.meta_json, bm25(<fts>[, w1, w2...]) AS bm
FROM "<fts>" JOIN "<docs>" d ON d.rowid = <fts>.rowid
WHERE <fts> MATCH ?
ORDER BY bm, d.id
```
- The MATCH argument is `sanitizeFtsQuery(query)` (`search/tokenize.ts:22-26`): lowercase,
  tokenize with `/[\p{L}\p{N}]+/gu`, quote each token (doubling `"`), join with ` OR `.
  Empty yields `[]` without querying.
- Weights come from `fieldWeightsFor` (`search/fields.ts:49-56`), default 1 per field, inlined
  into the SQL as literals.
- **Score is `-bm25`**, so higher is better (`:1507`).
- Ordering (`bm`, then `d.id` ascending under SQLite BINARY) is in SQL. The metadata
  `filter.where` is applied **in JS after fetching all matches**, then `slice(limit)`, so the
  filter runs before the limit (`:1489-1509`). Default limit is 10.
- `remove` and `search` return early (`false` / `[]`) when the collection has no schema row.
- Legacy upgrade path (`:1331-1348`): if the docs table exists but no schema row does, and the
  table has a `text` column, it registers `["text"]` retroactively.

## B.5 Vectors

Base table (`:916-926`), observed:
```sql
CREATE TABLE vectors (
         collection TEXT NOT NULL, id TEXT NOT NULL, vec BLOB NOT NULL, metadata TEXT,
         PRIMARY KEY (collection, id))
CREATE INDEX vectors_collection ON vectors(collection)
CREATE TABLE _vec_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)
```
One shared table with a `collection` column, unlike KV collections. Observed row for `[1,2,3]`:
`hex(vec)` = `0000803F 00000040 00004040`, i.e. **little-endian float32, tightly packed, no
header and no length prefix** (`vector/cosine.ts:25-31`, explicit `writeFloatLE`). Python:
`struct.pack(f'<{n}f', *vec)` or `np.asarray(v, '<f4').tobytes()`. Dimension is implied by
`len(blob)//4` on read (`cosine.ts:34-41`).

`metadata` is `JSON.stringify(doc.metadata)` or SQL NULL (`:1061`).

**Dimensions live in `_vec_meta` as the row `('dimensions', '<n>')`** (`:956-961`), observed
`("dimensions","3")`, a decimal string rather than an integer column. Reopening with a
different `dimensions` option throws (`:934-938`).

vec0 acceleration: sqlite-vec is optional (`tryLoadSqliteVec`, `:88-106`). It IS installed in
this checkout, and the probe ran with `meta.accelerated === true`. Per collection:
```sql
CREATE VIRTUAL TABLE vectors_vec_vc_ji38gu USING vec0(embedding float[3] distance_metric=cosine)
```
Name is `vectors_vec_<sanitized>_<hashName>` (`:989-993`). **Cosine metric, stated explicitly,
not vec0's L2 default.** Shadow tables `_chunks`, `_info`, `_rowids`, `_vector_chunks00` are
sqlite-vec's own.

The vec0 row is keyed by the `vectors` row's **rowid**, bound as a BigInt (`:1027-1042`). On
`ensureVecTable` the adapter backfills every existing row of that collection into vec0
(`:1005-1021`), so a file written by a non-accelerated session becomes complete on the first
accelerated open. Vectors that are all-zero or non-finite (`isUsableVector`, `cosine.ts:48-56`)
are deliberately **omitted from vec0** and skipped by the JS path, so both paths agree.

Search dispatch (`:1142-1172`): the vec0 path runs only when accelerated AND the query is
usable AND there are no `where`/`whereNot` filters, since metadata is not in vec0. Any vec
runtime error falls through to the JS path. vec0 SQL is
`WHERE vv.embedding MATCH ? ORDER BY vv.distance LIMIT ?`, and score is `1 - distance`.
Both paths sort `b.score - a.score || a.id.localeCompare(b.id)` (`:1205`, `:1234`). Note
**`localeCompare`, which is locale collation, not code-unit order**. It is a tie-break only,
but it is a genuine port hazard: Python's `<` will disagree on case and accents.

## B.6 Namespaces

Namespacing is NOT physical. `namespaceStore(store, ns)` (`namespace.ts:28-71`) wraps a store
and prefixes both KV keys and collection *names* with `ns + U+001F`. So a namespaced collection
`records` under namespace `fault` becomes the physical table
`c_fault_records_<hashName("fault" + U+001F + "records")>`: the separator sanitizes to `_`, and
the hash is over the prefixed name. Key `winner` under `shared.race.v1` becomes the `_kv` key
`shared.race.v1` + U+001F + `winner`. The namespace must be non-empty and must not contain
U+001F (`namespace.ts:16-22`). Atomic targets and idempotency keys are prefixed the same way
and unprefixed on the way out (`namespace.ts:96`, `:114`, `:129-143`).

A Python port sharing files with a namespaced TypeScript writer must apply the identical
U+001F prefixing *before* computing table names.

## B.7 Can Python (stdlib sqlite3 plus sqlite-vec) read and write these files identically?

**Yes for the storage layer, with a short list of real obstacles.** Nothing in the schema
depends on a better-sqlite3 extension: plain tables, JSON1 (`json_extract`/`json_type`, present
in every modern SQLite build), FTS5, and vec0. Python's `sqlite3` can open the same WAL file
concurrently with the Node process. The `sqlite-vec` Python package loads the same `vec0`
module, and the on-disk vec0 shadow tables are format-compatible because the same extension
writes them.

Obstacles, each concrete:

1. **JSON text is not canonical.** `data`, `_kv.value`, `metadata`, and `meta_json` are
   `JSON.stringify` output with **insertion key order preserved**. Python `json.dumps` also
   preserves dict order, so round-tripping works, but any byte-level comparison of a
   Python-written row against a TS-written row differs unless the Python side builds the dict
   in the same order. Semantics are unaffected: `json_extract` does not care. Only byte
   equality and hashes do.
2. **Number formatting.** `JSON.stringify(1.0)` gives `1`; Python `json.dumps(1.0)` gives
   `1.0`. Verified in the probe: the field `n: 1.0` was stored as `"n":1`. `json_extract`
   returns `1` versus `1.0` with different storage classes (INTEGER vs REAL), and
   `json_extract(...) = 1` still matches `1.0` numerically, so filtering survives. But
   `json_type` reports `integer` versus `real`, and the stored text differs. Fix: emit integral
   floats as ints on the Python side with a custom encoder. Also mind large integers: JS
   numbers lose precision beyond 2^53, Python ints do not.
3. **`undefined` is silently stripped.** Verified: writing `{b,a,n,u:undefined,d,nul}` stored
   `{"b":1,"a":2,"n":1,"d":"...","nul":null}`. The `u` key is gone entirely while `null` is
   kept. Python has no `undefined`; a port must treat "omit the key" as the equivalent and
   never write JSON `null` where TS would have dropped the field. This matters because
   `where: {f: null}` matches an explicit null but NOT a missing key (`sql.ts:36-42`).
4. **`Date` serializes to an ISO-8601 string.** Verified: `new Date(0)` stored as
   `"1970-01-01T00:00:00.000Z"`. Python must emit exactly millisecond precision, always three
   digits, always a UTC `Z` suffix. Plain `datetime.isoformat()` gives microseconds and
   `+00:00`, which does not match.
5. **Booleans.** Stored as JSON `true`/`false` (verified `"flag":true`) but bound as `1`/`0` in
   `where` clauses. Python's `sqlite3` binds `True` as `1` anyway, so this is nearly free, but
   the port must not bind the string `"true"`.
6. **String ordering diverges in three places.** JS UTF-16 code-unit order in the graph sorts
   and in `keys()` post-processing; SQLite BINARY (UTF-8 byte) order in `ORDER BY key` and
   `ORDER BY bm, d.id`; and `localeCompare` in the vector tie-break. Python's default `<`
   matches SQLite BINARY for code-point comparison but not the JS astral case and not
   `localeCompare`. Pin ascii ids in the corpus, or reproduce each order explicitly.
7. **`hashName` must be reimplemented over UTF-16 code units**, not UTF-8 bytes and not code
   points. Get this wrong and Python writes to a different physical table than TS reads. A
   Python implementation was verified against nine real table names.
8. **Identity row and version sequence.** A Python writer must reuse the existing
   `_mirk_atomic_identity` value (it is `INSERT OR IGNORE`, so just read it) and use the same
   `UPDATE ... value + 1` sequence, or version strings will not be comparable across writers.
9. **`request_digest` requires reimplementing `canonicalJson` exactly** (code-point key sort,
   JS number formatting, the rejection rules) plus SHA-256, or Python-written receipts look
   like idempotency conflicts to the TS side. Only needed if the Python port participates in
   atomic mutations.
10. **`created_at`/`updated_at` come from SQLite `datetime('now')`**, so they are consistent
    across languages for free, as long as the Python port also lets SQLite fill them rather
    than binding a Python timestamp.
11. **Pragmas must match on open.** `journal_mode=WAL` is persistent and already set in the
    file. `busy_timeout` is per-connection and must be set explicitly in Python or concurrent
    writes raise `database is locked` immediately. `foreign_keys=ON` is per-connection, and no
    foreign keys are declared in any table, so it is cosmetic today.
12. **FTS5 and vec0 must exist in the Python build.** Stdlib `sqlite3` on macOS and Linux
    normally has FTS5 compiled in. vec0 needs the `sqlite_vec` package plus
    `conn.enable_load_extension(True)`, which some distro Python builds disable at compile
    time. Without vec0, Python can still read and write the `vectors` base table and use the
    exact-cosine path, which is exactly what the TS fallback does, and the adapter backfills
    vec0 on the next accelerated open.
13. **No schema version means no compatibility signal.** If the layout changes, a Python reader
    has nothing to check. Worth adding a `_mirk_meta` row as part of the port rather than
    discovering the drift later.

---

# C. `coordination.ts`: is it a cross-process contract?

`coordination.ts` (620 lines) is a **cross-process** SQLite-backed advisory lock, not an
in-process one, and a Python process that wants exclusion against the TypeScript writers must
honor it. `SqliteCoordinator` opens its own better-sqlite3 connection (`:133`, its own
`busy_timeout`, its own `journal_mode = WAL`) and creates two tables (`:137-155`):
`_mirk_coordination_generations (namespace, key, last_generation, PK(namespace,key))` and
`_mirk_coordination_leases (namespace, key, owner_token, fencing_generation, acquired_at_ms,
expires_at_ms, updated_at_ms, PK(namespace,key))`. `runExclusive(key, work, opts)` first
serializes callers **within** the process through an in-memory promise queue keyed by
`namespace` + NUL + `key` (`:249-283`), and that part is purely in-process. It then acquires a
durable lease: an IMMEDIATE transaction that inserts a lease row if none exists, or steals one
only when `expires_at_ms <= now`, guarded by a compare-and-set on the previous
`fencing_generation` (`:311-368`). Each acquisition bumps a monotonic per-key generation
(`:371-390`), so a fencing token is available to reject stale writers. While the caller's work
runs, outside any DB transaction, a `setInterval` renews the lease every `renewEveryMs`
(default `leaseMs/3`, required to be less than `leaseMs`; defaults are `waitMs=30000`,
`leaseMs=5000`), and a failed renewal aborts the guard's signal with
`CoordinationOwnershipLostError` (`:216-224`, `:392-410`). Release is a conditional DELETE
matching owner token, generation, and non-expiry (`:414-430`). Because ownership lives entirely
in those two rows, **the contract is the row protocol, not the API**: a Python participant must
use the same table names, the same `(namespace, key)` identity, the same millisecond epoch
integers, the same expiry-based steal rule, and the same generation bump, and must be prepared
for a lease it holds to be stolen after expiry. The namespace here is the coordinator's own
`SqliteCoordinatorOptions.namespace` (default `"default"`), unrelated to `namespaceStore`'s
U+001F key prefixing. Nothing else in `@mirk/store` calls the coordinator: the KV facet's own
atomicity comes from SQLite transactions plus `_mirk_atomic_versions`. So a Python process that
only does atomic mutations does not need the coordinator, and one that runs multi-statement
critical sections does.
