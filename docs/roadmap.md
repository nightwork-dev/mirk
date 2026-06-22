# Roadmap — mirk

What's open for mirk — substrate storage primitives, no domain baked in. For shipped history see
[CHANGELOG.md](../CHANGELOG.md).

mirk ships storage **primitives** as code-split subpaths under one namespace: key-value, collections,
and vector today (`@mirk/store`), with a libSQL/Turso source adapter (`@mirk/store-libsql`). The bar
for a new primitive is **scope discipline**: a genuinely generic, substrate-level shape with ≥2 real
consumers — never a domain framework dressed up as substrate.

## How this roadmap works

Every item has a **stable `MR-NN` ID** (never renumbered or reused, so a reference survives), plus
**Pkg / Horizon / Status**. Reference items by ID across repos / commits / the bus the way deadletters
uses `FR-2` / `#10`. Items that originate as a deadletters feature request carry a **Ref** (`FR-N`).
(gonk's own roadmap uses `GR-NN`; mirk's is `MR-NN` — distinct namespaces.)

| ID | Title | Pkg | Horizon | Status | Ref |
| --- | --- | --- | --- | --- | --- |
| MR-01 | Graph primitive — edge model + traversal | @mirk/store/graph | near | designed | DL graph FR |
| MR-02 | Event primitive | @mirk/events | med | agreed, not started | FR-4 |
| MR-03 | Addressable no-drop inbox | @mirk/inbox | maybe | proposed | convergence proposal |

---

## Near term

### MR-01 · Graph primitive — edge model + traversal

**Pkg:** @mirk/store/graph · **Horizon:** near · **Status:** designed (not built) · **Ref:** DL graph FR

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
  vector+kv ports until this ships, then swaps cleanly.

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
