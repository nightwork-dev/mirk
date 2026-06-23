# Roadmap — mirk

What's open for mirk — substrate storage primitives, no domain baked in. For shipped history see
[CHANGELOG.md](../CHANGELOG.md).

mirk ships storage **primitives** as code-split subpaths under one namespace: key-value, collections,
and vector today (`@mirk/store`), with a libSQL/Turso source adapter (`@mirk/store-libsql`). The bar
for a new primitive is **scope discipline**: a genuinely generic, substrate-level shape with ≥2 real
consumers — never a domain framework dressed up as substrate.

As of `@mirk/store@0.5.0`, **`@gonk/store`** (the gonk harness's substrate store) backs its
KV / blob / log / vector stores onto **`@mirk/store/sqlite`** through a `MirkStoreBackend` adapter —
so nearly every gonk storage consumer (jobs, work-items, rlm, handoff, comms, curator, reflector,
self-model-reflector) now runs on mirk, with a self-migrating carry-forward from the old filesystem
backend. That broad adoption is what surfaced **MR-05** (knowledge's full-text gap) and **MR-06**
(sqlite-adapter ergonomics) below — both real-consumer-driven, not speculative.

## How this roadmap works

Every item has a **stable `MR-NN` ID** (never renumbered or reused, so a reference survives), plus
**Pkg / Horizon / Status**. Reference items by ID across repos / commits / the bus the way deadletters
uses `FR-2` / `#10`. Items that originate as a deadletters feature request carry a **Ref** (`FR-N`).
(gonk's own roadmap uses `GR-NN`; mirk's is `MR-NN` — distinct namespaces.)

| ID | Title | Pkg | Horizon | Status | Ref |
| --- | --- | --- | --- | --- | --- |
| MR-01 | Graph primitive — edge model + traversal | @mirk/store/graph | near | shipped · adopted by DL | FR-5 |
| MR-02 | Event primitive | @mirk/events | med | agreed, not started | FR-4 |
| MR-03 | Addressable no-drop inbox | @mirk/inbox | maybe | proposed | convergence proposal |
| MR-04 | Batch/IN match on the collection port (graph fast-path) | @mirk/store | near | designed | FR-5/MR-01 |
| MR-05 | Full-text search primitive (FTS + ranking) | @mirk/store/search | near | shipped · knowledge adoption pending | @gonk/store adoption |
| MR-06 | SqliteAdapter: expose connection / lazy vector dimensions | @mirk/store/sqlite | near | identified | @gonk/store adoption |

---

## Near term

### MR-01 · Graph primitive — edge model + traversal

**Pkg:** @mirk/store/graph · **Horizon:** near · **Status:** shipped (@mirk/store@0.5.0) · **Ref:** FR-5 (deadletters)

**Shipped** — `@mirk/store/graph` exports `neighbors` + `traverse` (pure, load-once fanout-free BFS
over the `AsyncStore` collection port; flat `{id,from,to,type,…}` edge records; policy via a
caller-supplied `edgeFilter`; not graphRAG). Independently reviewed (annika: SHIP — cycle-safe,
correct depth/direction semantics, policy pruned at load, port-agnostic so sqlite/libsql get it
free). 22 tests + a locked full-record-preservation contract. **Adopted** — DL's `getNeighbors` now runs
on `traverse()` (Annika-fuzzed at 50k vs the old BFS); the full-record + id-opaque + edgeFilter-at-load
contracts all held in the wild. **Remaining:** the at-scale fast-path is now **MR-04** (a port IN/batch-match
capability — `traverse`'s load-once is a full edge scan per call, fine at current scale but
`O(total_edges × hits)` for graphSearch); plus the **graph-specific** pilot — port `@gonk/memory`'s `TripleStore` onto `@mirk/store/graph`
(distinct from the broad `@gonk/store` → sqlite adoption noted in the intro, which covers
KV/collections/vector but not graph).

The fourth code-split primitive next to key-value / collections / vector. A graph **primitive** — edge
model + traversal — explicitly **not** graphRAG.

- **Shape.** Edges = a collection of `{ from, to, type, ...meta }` records. Traversal = **pure
  batched-BFS functions over the existing `AsyncStore` collection port + `StoreFilter`**:
  `neighbors(store, { from, edgeTypes, direction })` and `traverse(store, { start, depth, direction,
  edgeTypes })` with per-depth-level batching (avoid query fan-out) + dedup. Because it rides the
  collection port it works over in-memory / sqlite / libsql **for free** — zero new native deps, no
  new adapter. A `GraphStore` port + in-memory reference matching the `/kv` and `/vector` pattern; the
  cross-backend parity test is the contract.
- **Policy stays out of the primitive.** Published/status filtering, edge-type semantics
  (e.g. `in-series`), and bitemporal validity ride a caller-supplied `edgeFilter` (`StoreFilter`).
  graphRAG search (embed → vectorSearch → neighbor-expand → score) is thin glue + per-consumer policy
  — it stays consumer-side (same call as no speculative `compareAndSwapJson`).
- **Consumers (real, not speculative).** deadletters' `getNeighbors`; `@gonk/memory`'s `triples.ts`
  (a subject·predicate·object `TripleStore` that *already* rebuilt mirk's port+adapter+parity pattern
  because mirk lacked a graph primitive); plausibly `@gonk/knowledge` term/doc relations.
- **Plan.** Take DL's `getNeighbors` reference impl + edge-type taxonomy; **dry-season pilot** by
  porting `@gonk/memory`'s `TripleStore` onto it (it already has the parity harness) and proving it
  green before opening breadth. Not a DL `#10` blocker — DL keeps its graph-service over the
  vector+kv ports until this ships, then swaps cleanly. DL's `#10` store rebuild extracts a
  graph-service (graphSearch + computeDerivedEdges + traversal) that is the concrete
  consumer-in-waiting — it plugs straight into this primitive the moment it lands.

### MR-04 · Batch/IN match on the collection port — the graph fast-path's prerequisite

**Pkg:** @mirk/store · **Horizon:** near · **Status:** designed (not started) · **Ref:** FR-5 / MR-01

MR-01's at-scale `traverse` fast-path is **not** just a libsql override — it needs a **new port capability**.
`StoreFilter.where` is exact-match only, so a start-anchored / frontier-IN prefilter
(`WHERE from_id IN (frontier) OR to_id IN (frontier)`) **cannot be expressed through `list()`** — even a
smarter traverse can't reach it. The fix: an IN / array-match on `StoreFilter` (or a dedicated batch-edge
query), pushed into each **per-level** `WHERE … IN (…)` with the `edgeFilter` policy preserved (else the
at-scale path diverges from load-once). Measured by DL's adopted `getNeighbors`: load-once does one full
`list("edges")` scan per call, so graphSearch is `O(total_edges × hits)` — invisible at DL's corpus, and the
swap is internal (no DL change). Design against DL's `getEdgesBatch` (indexed `idx_edges_from`/`idx_edges_to`).
Load-once stays the correct default; the IN-path is the indexed override behind the same signature.

### MR-05 · Full-text search primitive — the one thing blocking knowledge

**Pkg:** @mirk/store (a `/search` subpath or an FTS facet on the sqlite adapter) · **Horizon:** near ·
**Status:** identified (real consumer, not started) · **Ref:** @gonk/store adoption

Every `@gonk/store` consumer now runs on `@mirk/store/sqlite` **except `@gonk/knowledge`** — and it is
blocked on exactly one thing. Knowledge does sqlite **FTS5 + bm25 keyword ranking** over title+body;
`@mirk/store/sql`'s `StoreFilter.where` is exact-match only (no `MATCH`, no ranking), so it cannot
express keyword search. The requirement: a substrate **full-text** primitive — FTS5 with bm25 ranking
and a query/score API, optional native acceleration (the vec0/sqlite-vec pattern), behind the same
port + cross-backend parity contract as the other primitives. **Consumer:** `@gonk/knowledge`
(`search()`). Note: knowledge ALSO wants a supersession/correction **audit trail** (append-only version
history) — that is an append-log concern closer to **MR-03**, not this primitive; keep MR-05 scoped to
full-text + ranking.

### MR-06 · SqliteAdapter ergonomics — expose connection or lazy vector dimensions

**Pkg:** @mirk/store/sqlite · **Horizon:** near · **Status:** identified (small) · **Ref:** @gonk/store adoption

`@gonk/store`'s `MirkStoreBackend` (which puts gonk's KV/blob/log/vector stores on the sqlite adapter)
hit one friction point: the `.vector` facet needs `dimensions` at `SqliteAdapter` construction, but the
consuming SPI only learns the dimension at the first `upsert(id, vector)`. To build the vector facet
lazily over the SAME connection, the backend had to reach into the adapter's **private `db` field** via
a cast — fragile coupling to mirk internals. Fix, either: (a) expose the underlying `better-sqlite3`
connection (a public getter), or (b) let `.vector` accept `dimensions` lazily / be re-initialized
post-construction. Small, but it removes a private-field reach in a real shipped consumer.

---

## Medium term

### MR-02 · Event primitive — `@mirk/events`

**Pkg:** @mirk/events (new) · **Horizon:** med · **Status:** agreed, not started · **Ref:** deadletters FR-4

An agreed mirk event primitive (deadletters **FR-4**) — the plumbing layer beneath cross-agent
messaging and temporal concerns. Design-open; the spec lives in the deadletters/mirk FR docs, not yet
in this repo. Likely gonk-side consumers: `@gonk/comms` (messaging) and `@gonk/temporal`. Not started.

---

## Maybe later

### MR-03 · Addressable no-drop inbox — `@mirk/inbox` (proposed)

**Pkg:** @mirk/inbox (proposed) · **Horizon:** maybe · **Status:** proposed · **Ref:** messaging-convergence proposal

A possible no-drop, addressable **append-log + status** layered over `@mirk/store` kv — the durable
inbox substrate under cross-agent messaging. Open question whether `@gonk/work-items` rests on it.
Surfaced in the messaging-convergence proposal; not committed — promote if a second consumer beyond
the messaging leg appears.
