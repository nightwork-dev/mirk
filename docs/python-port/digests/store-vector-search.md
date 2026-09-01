# Semantics digest: `@mirk/store` vector + search ports

Scope: observable behavior of the `/vector` and `/search` ports, precise enough to
reimplement in Python and to write a language-neutral JSON conformance corpus.
All paths relative to `/Users/dr/Dev/platform/mirk`.

Backends covered:

| Backend | Entry | Notes |
| --- | --- | --- |
| in-memory vector | `packages/store/src/vector/memory.ts` | reference implementation |
| sqlite vector | `packages/store/src/adapters/sqlite.ts:899` (`SqliteVectorFacet`) | two sub-paths: vec0 accelerated, exact JS cosine |
| in-memory search | `packages/store/src/search/memory.ts` | pure-JS bm25 reference |
| sqlite search | `packages/store/src/adapters/sqlite.ts:1285` (`SqliteSearchFacet`) | FTS5 external-content + `bm25()` |

---

## A. Vector port

### A.1 Types and signatures

`packages/store/src/vector/types.ts`

- `Vector = Float32Array` (types.ts:13). The on-disk encoding is little-endian float32.
- `VectorStoreMeta` (types.ts:15-24): `{ backend: string; dimensions: number; accelerated: boolean }`.
  `accelerated` is informational only; ranking is documented as identical either way.
- `VectorDocument<M>` (types.ts:26-35): `{ id: string; vector: Vector; metadata?: M }`.
  **The field is `metadata`, not `meta`** (the search port uses `meta` — they differ).
  `metadata` must be JSON-serializable; disk backends drop `undefined`/functions.
- `VectorSearchResult<M>` (types.ts:37-42): `{ id: string; score: number; metadata?: M }`.
  `score` is cosine similarity in `[-1, 1]`, higher = more similar.
- `VectorSearchOptions` (types.ts:44-56):
  - `topK?: number` — default `10` (memory.ts:78; sqlite.ts:1145).
  - `minScore?: number` — inclusive floor; a result is kept when `score >= minScore`
    (excluded when `score < minScore`). Default: no floor.
  - `where?: Record<string, unknown>` — pre-KNN: keep only docs matching ALL conditions.
  - `whereNot?: Record<string, unknown>` — pre-KNN: drop docs matching ALL conditions
    (see A.5 — the doc comment says "ANY", the implementation is "ALL").
  - `where` and `whereNot` are independent; both may be given.
- `VectorStore` (types.ts:63-100), all synchronous:
  - `meta: VectorStoreMeta` (readonly property)
  - `upsert(collection, doc): void`
  - `upsertMany(collection, docs): void`
  - `get(collection, id): VectorDocument | null`
  - `has(collection, id): boolean`
  - `remove(collection, id): boolean` — true iff it existed
  - `count(collection): number`
  - `search(collection, query, opts?): VectorSearchResult[]`
- `AsyncVectorStore` (types.ts:108-137) is the same surface with `Promise` returns,
  except `meta` which stays a synchronous property. `toAsyncVector`
  (`vector/to-async-vector.ts:66`) wraps a sync store; sync throws become rejections.
  There is no `list` and no `clear` on this port.

### A.2 Dimension handling

- **In-memory**: dimensions are fixed at construction (`InMemoryVectorStoreOptions.dimensions`,
  memory.ts:16-19). `meta.dimensions` equals that value immediately.
- **SQLite**: dimensions are optional at open and can be established lazily
  (sqlite.ts:904, 942-963). State machine:
  - internal `dimensions = -1` means "unknown"; `meta.dimensions` reports `max(dimensions, 0)`,
    so an unconfigured store reports `0` (sqlite.ts:969).
  - Persisted in table `_vec_meta` under key `'dimensions'` as a TEXT value (sqlite.ts:924, 956).
  - Reopening with an explicit `dimensions` that differs from the persisted value throws:
    `` `Vector store at ${path} was created with ${stored} dimensions, opened with ${passed}.` ``
    (sqlite.ts:930-933, and again at 950-954).
  - `upsert` / `upsertMany` initialize dimensions from the first vector when unknown
    (`ensureDimsForWrite`, sqlite.ts:982-985).
  - `search` refuses to run when dimensions are unknown (`requireKnownDims`, sqlite.ts:973-980):
    `"SqliteAdapter.vector has no dimensions yet — pass { dimensions } when opening or upsert a vector first."`
  - `assertPositiveDimensions` (sqlite.ts:107-113) rejects non-integer or `<= 0`:
    `` `Vector dimensions must be a positive integer; got ${dimensions}.` ``
- **Mismatch error, shared by every backend** (`vector/cosine.ts:60-63`):
  `` throw new Error(`Vector dimension mismatch: expected ${dimensions}, got ${vector.length}`) ``
  Raised by `upsert`, every element of `upsertMany`, and `search`'s query vector.

### A.3 Cosine similarity — exact formula

`vector/cosine.ts:6-20`

```
cosineSimilarity(a, b):
  if len(a) != len(b): return 0.0
  dot = an = bn = 0.0
  for i in range(len(a)):
      av = a[i]; bv = b[i]
      dot += av*bv; an += av*av; bn += bv*bv
  if an == 0 or bn == 0: return 0.0
  return dot / (sqrt(an) * sqrt(bn))
```

Notes for a port:
- Accumulation is in float64 over float32 inputs. In Python, read the array as float32
  and accumulate in Python floats (float64) to match bit-for-bit within tolerance.
- Denominator is `sqrt(an) * sqrt(bn)`, **not** `sqrt(an * bn)`. These differ in the
  last ulp; keep the two-sqrt form.
- Length mismatch returns `0`, it does not throw. (The throwing check is `assertDimensions`,
  applied by the store before calling this.)
- A NaN component makes the result NaN; the store filters NaN separately (A.4).

### A.4 Usability gate (zero / non-finite vectors)

`isUsableVector` (`vector/cosine.ts:48-56`):

```
usable(v): all components finite AND at least one component != 0
```

An unusable **stored** vector is excluded from search results on every backend and
every path — in-memory (memory.ts:90), sqlite JS path (sqlite.ts:1228), and vec0
(kept out of the vec0 index entirely, sqlite.ts:1035-1041, plus the `distance === null`
guard at sqlite.ts:1194). It is still stored, still returned by `get`, still counted
by `count`, still found by `has`.

An unusable **query** vector does not throw. It routes to the deterministic JS path
(sqlite.ts:1155-1157), where every usable stored doc scores `0` (cosine returns 0 for a
zero query) and results come back in id order.

A second, independent guard drops non-finite *scores* after computation
(`Number.isFinite(score)`, memory.ts:92, sqlite.ts:1196, sqlite.ts:1230). This is what
stops a NaN score from slipping past `minScore` (NaN comparisons are always false).

### A.5 Metadata filter (`matchesWhere`)

`vector/filter.ts:10-25`. Shared by both ports.

```
matchesWhere(metadata, filter):
  if metadata is None/undefined: return False
  for key, expected in filter.items():          # insertion order
      actual = metadata.get(key)                # missing -> undefined
      if actual is expected (JS ===): continue  # fast path
      if json(actual) != json(expected): return False
  return True
```

Exact semantics a port must reproduce:
- **Exact match only.** No operators, no ranges, no `$`-prefixed syntax.
- **All conditions must hold** (AND). An empty filter object matches any non-null metadata.
- **Missing metadata never matches a filter**, even an empty one — the `if (!metadata) return false`
  guard fires first. For the vector port `metadata` is `undefined` when absent; for the search
  port the stored value is `{}` (never absent), so an empty `where` matches every search doc
  but no metadata-less vector doc. This asymmetry is real.
- **Missing key**: `actual` is `undefined`, `JSON.stringify(undefined)` is the JS value
  `undefined` (not a string), compared against the expected's JSON string — never equal for
  any JSON-representable expected value, so it fails. But `where: {k: undefined}` matches
  a doc lacking `k`, via the `===` fast path.
- **Nested objects and arrays** compare by `JSON.stringify` equality, which is
  **key-order sensitive**: `{a:1,b:2}` does not match `{b:2,a:1}`. Array order matters.
- **`null`** matches `null` via `===`. `NaN` in metadata serializes as `null`.
- **No array-contains semantics.** `where: {tags: "x"}` does not match `metadata.tags === ["x"]`.
- `whereNot` **excludes a doc when `matchesWhere(meta, whereNot)` is true**, i.e. when the doc
  satisfies ALL the `whereNot` conditions (memory.ts:87, sqlite.ts:1226). The doc comment in
  types.ts:53 says "ANY"; the code says ALL. Follow the code. Only observable with a
  multi-key `whereNot`, which no current test exercises.

### A.6 search algorithm (canonical, in-memory / JS path)

```
search(collection, query, opts):
  assertDimensions(query, dims)          # throws on mismatch
  topK = opts.topK ?? 10
  minScore = opts.minScore
  if collection unknown: return []
  out = []
  for doc in collection.values():        # any order; result order is fully determined below
      if opts.where and not matchesWhere(doc.metadata, opts.where): continue
      if opts.whereNot and matchesWhere(doc.metadata, opts.whereNot): continue
      if not usable(doc.vector): continue
      score = cosineSimilarity(query, doc.vector)
      if not isfinite(score): continue
      if minScore is not None and score < minScore: continue
      out.append({id, score, metadata})
  out.sort(key = (-score, id))           # score desc, then id ascending
  return out[:topK]
```

Ordering and tie-breaks (memory.ts:98, sqlite.ts:1210, sqlite.ts:1236):
`b.score - a.score || a.id.localeCompare(b.id)`. Score descending; equal scores break by
**id ascending**, never insertion order. Note `localeCompare` is locale-aware collation,
not code-point order — see section D.

Filter-before-scoring is load-bearing: `topK` is applied to the surviving set, so a
filtered search returns up to `topK` matching docs rather than `topK` nearest docs
that are then filtered.

### A.7 SQLite vector specifics

- Base table (sqlite.ts:912-921):
  `vectors(collection TEXT, id TEXT, vec BLOB NOT NULL, metadata TEXT, PRIMARY KEY (collection, id))`
  plus `vectors_collection` index and `_vec_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL)`.
  `metadata` is `NULL` when absent, otherwise `JSON.stringify(metadata)`.
- vec0 shadow table per collection, named
  `` `vectors_vec_${collection.replace(/[^a-zA-Z0-9_]/g,"_")}_${hashName(collection)}` ``
  (sqlite.ts:989-992), created as
  `vec0(embedding float[N] distance_metric=cosine)` — the cosine metric is explicit,
  NOT vec0's L2 default (sqlite.ts:998-1001).
- `hashName` (`packages/store/src/sql.ts:78-85`) is FNV-1a 32-bit rendered base-36:
  ```
  h = 2166136261
  for ch in s: h ^= ord(ch) & 0xFFFFFFFF ... ; h = (h * 16777619) mod 2**32   # JS uses charCodeAt = UTF-16 code unit
  return base36(h)
  ```
  A Python port iterating over code points diverges from JS for non-BMP characters,
  which JS splits into surrogate pairs.
- **Score conversion on the vec0 path**: `score = 1 - distance` (sqlite.ts:1195), with
  `distance` being vec0's cosine distance. A `NULL` distance row is skipped (sqlite.ts:1194).
- **Path routing** (sqlite.ts:1149-1163): the accelerated path runs only when
  `accelerated && isUsableVector(query) && !(where || whereNot)`. Any exception from the
  vec0 query falls through to the JS path silently.
- **Known parity divergence, untested**: `searchVec` pushes `LIMIT topK` into SQL
  *before* applying `minScore` (sqlite.ts:1183-1200), while the JS path filters then
  slices. When more than `topK` candidates exist and some of the top `topK` fall below
  `minScore`, the accelerated path returns fewer rows than the JS path. Corpus authors
  should either avoid that combination or record it as a documented divergence.
- `upsertMany` (sqlite.ts:1062-1081): validates every vector first, initializes lazy
  dimensions only after validation passes, then writes inside one transaction. A
  mid-array mismatch therefore persists nothing — including the inferred dimensions.
  Empty array is a no-op that returns immediately without touching dimensions.
- `remove` deletes the vec0 row first, then the base row; returns `changes > 0`.
- `get` returns `metadata: undefined` when the column is NULL, else `JSON.parse`.

### A.8 Byte encoding (matters for a Python adapter reading the same file)

`vector/cosine.ts:25-41`

- `vectorToBuffer`: allocate `len * 4` bytes, write each element with `writeFloatLE`.
  Python equivalent: `struct.pack(f"<{n}f", *vals)` or `np.asarray(v, "<f4").tobytes()`.
  Explicit LE, so host byte order is irrelevant. The buffer is freshly allocated and
  never aliases the source's backing store (relevant for `Float32Array.subarray` views,
  which have a non-zero `byteOffset`).
- `bufferToVector`: output length is `floor(byteLength / 4)`; trailing bytes that do not
  form a full float are silently dropped.
- Values are already float32 by the time they are written (the input is a `Float32Array`),
  so encode/decode is lossless; a float64 Python source value must be rounded to float32
  first to match.

---

## B. Search port

### B.1 Types and signatures

`packages/store/src/search/types.ts`

- `SearchTextDocument<M>` (types.ts:18-28): `{ id, text: string, fields?: never, meta?: M }`.
- `SearchFieldDocument<M>` (types.ts:30-41): `{ id, fields: Record<string,string>, text?: never, meta?: M }`.
- `SearchDocument<M>` is the union. **The metadata field is `meta`** (vector uses `metadata`).
- `SearchOptions` (types.ts:45-54):
  - `limit?: number` — default `10` (memory.ts:107, sqlite.ts:1483).
  - `filter?: StoreFilter` — only `filter.where` is read. `sortBy`, `sortDir`, `limit`,
    `offset` on the filter object are **ignored** by this port (`StoreFilter` is defined at
    `packages/store/src/types.ts:16-27`). There is no offset/pagination on search.
  - `fieldWeights?: Record<string, number>` — per-field bm25 weights, unlisted fields default to 1.
- `SearchResult<M>` (types.ts:57-64): `{ id: string; score: number; meta: M }`.
  `meta` is always present, `{}` when nothing was indexed — unlike the vector port's
  optional `metadata`.
- `SearchStore` (types.ts:73-96): `index`, `indexMany`, `remove`, `search`. **No `get`,
  no `has`, no `count`, no `meta` property.**
- `AsyncSearchStore` (types.ts:100-118) + `toAsyncSearch` (`search/to-async-search.ts:40`).

### B.2 Field normalization

`search/fields.ts`

- `DEFAULT_SEARCH_FIELD = "text"` (fields.ts:3).
- `normalizeSearchDocument` (fields.ts:10-31):
  - both `text` and `fields` present → `"SearchDocument must provide either \`text\` or \`fields\`, not both."`
  - `text` present → `{ names: ["text"], values: { text } }`. So `{text: "x"}` and
    `{fields: {text: "x"}}` are the identical schema.
  - neither present → `"SearchDocument must provide \`text\` or \`fields\`."`
  - `fields` present → **names sorted ascending by JS `<`/`>` on the raw strings**
    (UTF-16 code-unit order, fields.ts:20), not `localeCompare`. This ordering fixes the
    column order for the whole collection and therefore the weight-vector order.
  - empty `fields` object → `"SearchDocument.fields must contain at least one field."`
  - a non-string field value → `` `SearchDocument field "${name}" must be a string.` ``
- `assertSameSearchFields` (fields.ts:33-39): a collection is pinned to its first
  document's field list; a differing list throws
  `` `Search collection "${c}" was initialized with fields [a, b], got [x].` ``
  Comparison is element-wise on the sorted arrays.
- `assertValidFieldWeightValues` (fields.ts:41-47): each weight must be finite and `>= 0`,
  else `` `Search field weight for "${f}" must be a non-negative finite number.` ``
  Zero is allowed.
- `fieldWeightsFor` (fields.ts:49-56): an unknown field name throws
  `` `Unknown search field weight "${f}".` ``; the result is one weight per collection
  field in collection-field order, defaulting to 1.

Validation order in `search`, identical on both backends: weight *values* are validated
before any collection lookup (so a bad weight throws even for a missing collection), while
*unknown field names* are only detected once the collection schema is known (so a missing
collection returns `[]` instead of throwing). memory.ts:104-109, sqlite.ts:1466-1476.

### B.3 Tokenizer

`search/tokenize.ts:13-16`

```
tokenize(text):
  if text is empty/falsy: return []
  return all matches of /[\p{L}\p{N}]+/u against text.lower()
```

Precise properties:
- **Lowercase first, then split.** JS `String.prototype.toLowerCase()` — full Unicode
  default case folding, locale-independent.
- A token is a maximal run of characters in Unicode general category `L*` (all letters)
  or `N*` (**all** numerics: `Nd` decimal, `Nl` letter-numbers like Ⅷ, `No` like ² or ½).
  Everything else is a separator, including `_`, `-`, `'`, `.`, whitespace, and emoji.
- **No stemming. No stopwords. No length limits. No diacritic stripping.**
- Numbers are ordinary tokens: `"v1.2"` → `["v1", "2"]`. `"don't"` → `["don", "t"]`.
- Combining marks (category `Mn`) are separators, so `"é"` (decomposed é)
  tokenizes as `["e"]` while precomposed `"é"` tokenizes as `["é"]`. Normalize inputs in
  the corpus or the two forms diverge.

`sanitizeFtsQuery` (tokenize.ts:22-26):

```
sanitize(q):
  toks = tokenize(q)
  if not toks: return ""
  return " OR ".join('"' + tok.replace('"','""') + '"' for tok in toks)
```

Because tokens can never contain a `"` (it is a separator), the quote-doubling is
defensive and unreachable. An empty result means "no results" — callers return `[]`.

### B.4 Query semantics

- **OR of terms**, not AND (`sanitizeFtsQuery` joins with `OR`; in memory, a doc matches
  when it contains *at least one* query term, memory.ts:115-136). A doc matching two
  terms simply scores higher.
- **No prefix matching, no phrase search, no operators.** User-typed `AND`, `OR`, `NOT`,
  `*`, `"` are tokenized into ordinary terms — `sanitizeFtsQuery` is what makes arbitrary
  punctuation safe rather than an FTS5 syntax error.
- Duplicate query tokens are not deduplicated in the in-memory scorer, so `"fox fox"`
  counts the term twice and doubles the score. In sqlite, `"fox" OR "fox"` is one MATCH
  clause and `bm25()` counts it once. **Scores diverge; ranking of a single-term-repeated
  query is unaffected because every doc doubles equally.**
- Empty or all-punctuation query returns `[]` before touching the collection.

### B.5 Scoring

**In-memory** (`search/memory.ts:98-143`), bm25 with FTS5 defaults `k1 = 1.2`, `b = 0.75`:

```
n      = number of docs in the collection
avgdl  = totalLen / n            # totalLen = sum of all docs' total token counts
score(doc, qTokens, weights):
  matched = False; score = 0.0
  for qt in qTokens:                       # duplicates counted repeatedly
      df = collection.df.get(qt, 0)        # docs containing qt in ANY field
      if df == 0: continue
      weightedTf = sum(weights[i] * tf(doc, field_i, qt) for i in range(len(fields)))
      if weightedTf == 0: continue
      matched = True
      idf = log((n - df + 0.5) / (df + 0.5))     # natural log
      if idf <= 0: continue                       # clamp: term in >= half the docs adds 0
      denom = weightedTf + k1 * (1 - b + b * (doc.dl / avgdl if avgdl > 0 else 0))
      score += idf * (weightedTf * (k1 + 1)) / denom
  return (matched, score)
```

- `doc.dl` is the **total** token count across all fields, unweighted.
- `df` counts a doc once per term regardless of how many fields contain it.
- A doc that matches only high-df terms is included with **score 0** (matched is set
  before the idf clamp). It still appears in results, ordered last among matches by id.
- A field weight of `0` makes `weightedTf` 0 for that field. If it is the only field
  containing the term, the doc is **not matched** in memory — but FTS5 still MATCHes it,
  so sqlite returns it. A weight-0 corpus case is a backend divergence.

**SQLite** (`sqlite.ts:1489-1503`): `score = -bm25(fts, w1, w2, ...)`. SQLite's `bm25()`
returns a negative number (lower = more relevant), so negating gives higher = more
relevant, matching the in-memory sign convention. Magnitudes differ from the in-memory
reference and are not asserted equal anywhere.

**The cross-backend contract is RANKING ORDER and the matching SET, not float scores.**
Stated in types.ts:66-72 and search.test.ts:1-6.

### B.6 Result ordering and limit

Both backends: score descending, ties by **id ascending**, then `slice(limit)`.
- memory.ts:141: `b.score - a.score || a.id.localeCompare(b.id)`
- sqlite.ts:1497: `ORDER BY bm, d.id` (bm ascending = best first; SQLite's default
  `BINARY` collation on `d.id` = code-point order, which is not the same as
  `localeCompare` — see section D)

The meta filter is applied **in JS after the SQL ordering and before the limit** on both
backends (sqlite.ts:1499-1502), so `filter` + `limit` behaves like the vector port's
filter + topK: the limit applies to the surviving set.

### B.7 SQLite search storage

- Schema registry table `_mirk_search_schema(collection TEXT PRIMARY KEY, fields_json TEXT NOT NULL)`
  (sqlite.ts:1288-1293), holding the sorted field-name array as JSON.
- Per collection: `search_docs_<safe>_<hash>` and `search_fts_<safe>_<hash>`, same
  `replace(/[^a-zA-Z0-9_]/g,"_") + hashName()` naming as the vector facet (sqlite.ts:1298-1310).
- Column names (sqlite.ts:1261-1264): the field literally named `text` keeps the column
  name `text`; every other field becomes `` `f${index}_${hashName(field)}` `` where `index`
  is its position in the sorted field list. This is what lets odd field names
  (`"title.with.dot"`, `"emoji 🔥"`) work.
- The FTS5 table is external-content over the docs table
  (`content='<docs>', content_rowid='rowid', tokenize='unicode61'`, sqlite.ts:1390-1392),
  kept in sync by AFTER INSERT / DELETE / UPDATE triggers.
- **Document-side tokenization is FTS5's `unicode61`, not `tokenize()`.** Only the *query*
  passes through the shared tokenizer. `unicode61` defaults to `remove_diacritics=1`, so
  sqlite folds `café` → `cafe` while the in-memory store does not. Any corpus entry with
  diacritics is backend-specific.
- Legacy upgrade path (sqlite.ts:1322-1345): a pre-schema database whose docs table has a
  `text` column is adopted as the default `{ text }` schema and the schema row is
  backfilled.
- `remove` on an unknown collection returns `false` without creating tables.

---

## C. Behavioral assertions in the existing tests (corpus candidates)

Marked `[C]` contract-level (must hold in any port) or `[B]` backend-specific.

### C.1 Vector — shared suite, run against InMemory, SQLite default, SQLite forced-JS-cosine (`vector.test.ts:29-245`)

- `[C]` upsert doc with metadata → get → vector components and metadata round-trip exactly (test:41).
- `[C]` get a never-inserted id → `null` (test:49).
- `[C]` upsert same id twice → get returns the second vector, count is 1 (test:53).
- `[C]` has → true for inserted, false for absent id, false for the same id in another collection (test:60).
- `[C]` upsert then remove → has is false (test:67).
- `[C]` three docs, two tagged `type:cat` → search with `where {type:"cat"}` → exactly the two cat ids (test:73).
- `[C]` same corpus → `whereNot {type:"cat"}` → only `dog-a` (test:83).
- `[C]` `where {type:"cat"}` + `whereNot {color:"black"}` → only the white cat (test:93).
- `[C]` one doc with metadata, one without → `where {type:"cat"}` → the metadata-less doc is excluded (test:106).
- `[C]` 3 cats + 1 dog, `where {type:"cat"}, topK:2` → 2 results, both cats (topK applies post-filter) (test:115).
- `[C]` remove returns true the first time, false the second; get is then null (test:127).
- `[C]` count is per collection; unknown collection counts 0 (test:134).
- `[C]` three docs at varying angles → search orders near, mid, far with strictly decreasing scores (test:143).
- `[C]` `topK: 2` over 3 docs returns 2 (test:155).
- `[C]` `minScore: 0.5` with an identical and an orthogonal doc → only the identical one (test:164).
- `[C]` search on a never-written collection → `[]` (test:173).
- `[C]` a 5-element vector against a 4-dim store throws `/dimension/` on both upsert and search (test:177).
- `[C]` upsertMany with a bad vector in the middle throws and inserts nothing; the pre-existing doc survives (test:183).
- `[C]` metadata with nested objects, arrays, booleans and null round-trips (test:198).
- `[C]` a doc indexed without metadata returns `metadata === undefined` (test:204).
- `[C]` a stored vector containing NaN never appears in results even at `minScore: -1` (test:211).
- `[C]` a stored all-zero vector never appears in results even at `minScore: -1` (test:220).
- `[C]` a stored vector containing Infinity never appears in results (test:229).
- `[C]` three docs with identical vectors inserted as c, a, b → results are a, b, c (id tiebreak, not insertion order) (test:236).

### C.2 Vector — SQLite-only

- `[B]` lazy dims: open with no `dimensions` → `meta.dimensions === 0`, `accelerated === false`;
  after the first upsert `meta.dimensions === 4`; reopen sees 4 and rejects a 3-dim upsert (test:257).
- `[B]` search before any dims are known throws `/no dimensions yet/`; `meta.dimensions` stays 0 (test:280).
- `[B]` upsertMany that fails validation does not persist lazy dimensions — a reopened store still reports 0 and can then adopt 3 (test:290).
- `[B]` vectors and metadata survive close + reopen, and are still searchable (test:317).
- `[B]` reopening a 4-dim store with `dimensions: 3` throws `/dimension/i` (test:338).
- `[B]` `meta.accelerated` is true only when the optional `sqlite-vec` peer loaded; `forceJsCosine` always yields false (test:411).
- `[B]` vec0 ranking equals exact-JS-cosine ranking over a non-normalized corpus for three different queries — catches a regression to vec0's L2 default (test:425).
- `[B]` accelerated `topK: 3` and `minScore: 0.5` results match the fallback (test:442).
- `[C]` per-collection isolation: identical vectors in collections A and B, a query in A returns only A's doc (test:461).
- `[B]` vec0 stays in sync across upsert-replace and remove (test:472).
- `[B]` zero and NaN stored vectors are excluded on both the accelerated and fallback paths, with identical ids (test:485).
- `[C]` an all-zero query returns every usable doc with score exactly 0, in id order (test:505).
- `[B]` a database written in a forced-fallback session is backfilled into vec0 when reopened accelerated, and searches non-empty (test:518).
- `[B]` identical-vector ties break by id identically on both paths (test:542).

### C.3 Vector — cosine helpers (`vector.test.ts:355-369`)

- `[C]` `cosineSimilarity(zero, unit) === 0` (test:357).
- `[C]` `cosineSimilarity` of a 2-element and a 4-element vector is `0`, not an error (test:358).
- `[C]` `cosineSimilarity(v, v)` is approximately 1 (test:359).
- `[C]` `vectorToBuffer`/`bufferToVector` round-trip a `subarray` view with `byteOffset === 8`, preserving `[1, 0.5, -0.25, 0]` — the buffer must not alias the source's backing store (test:362).

### C.4 Vector — AsyncVectorStore (`vector.test.ts:565-625`)

- `[C]` `meta` is a synchronous property, delegating backend and dimensions (test:572).
- `[C]` upsert + get round-trip through Promises (test:577).
- `[C]` get of a missing id resolves to `null` (test:585).
- `[C]` has resolves true/false (test:589).
- `[C]` upsertMany + search resolve with near before far (test:595).
- `[C]` remove resolves true then false (test:605).
- `[C]` count resolves to 2 (test:611).
- `[C]` `where` is passed through to the sync backend (test:617).

### C.5 Search — shared suite, InMemory and SQLite (`search.test.ts:36-275`)

- `[C]` three docs, query `"fox"` → exactly the two docs containing it (test:48).
- `[C]` a term in no document → `[]` (test:58).
- `[C]` fielded docs → a term in either `title` or `body` matches; the doc with it in neither does not (test:63).
- `[C]` `{text: "..."}` and `{fields: {text: "..."}}` coexist in one collection and both match (test:72).
- `[C]` `fieldWeights {title:5, body:1}` ranks the title hit above the body hit with a strictly greater score (test:78).
- `[C]` odd field names (`"title.with.dot"`, `"emoji 🔥"`) and a literal `text` field work together with weights (test:91).
- `[C]` a doc whose field list differs from the collection's throws `/fields/`; so does a `text` doc in a `{title, body}` collection (test:111).
- `[C]` `fieldWeights` of `-1` or `NaN` throws `/weight/`; an unknown field name throws `/Unknown/` (test:117).
- `[C]` bad weight *values* throw even for a nonexistent collection, while a valid weight on a nonexistent collection returns `[]` (test:124).
- `[C]` re-indexing the same id drops the old terms from the index; remove drops the doc entirely (test:129).
- `[C]` `""`, `"   "` and `"!!!"` all return `[]` (test:138).
- `[C]` with filler docs keeping the term rare, a doc repeating it three times outranks one mentioning it once, with a strictly greater score (test:145).
- `[C]` a three-tier relevance fixture ranks high, mid, low with strictly decreasing scores (test:163).
- `[C]` `filter.where {type:"cat"}` narrows to the two cat docs (test:182).
- `[C]` `filter.where` excludes a doc indexed with no `meta` (test:192).
- `[C]` `meta` round-trips including nesting, and defaults to `{}` when none was indexed (test:201).
- `[C]` `limit: 2` returns 2 (test:213).
- `[C]` 12 identical docs with no `limit` returns 10 (test:222).
- `[C]` remove returns true then false, and the removed doc is gone from results (test:228).
- `[C]` index replaces by id; the old text no longer matches (test:239).
- `[C]` per-collection isolation: identical text in A and B, a query in A returns only A's doc (test:247).
- `[C]` search on a never-written collection returns `[]` (test:253).
- `[C]` identical texts inserted c, a, b → results a, b, c (id tiebreak) (test:257).
- `[C]` the query `shell "OR" scripting;` does not throw and matches the doc (test:268).

### C.6 Search — AsyncSearchStore, run over both backends (`search.test.ts:277-335`)

- `[C]` indexMany + weighted search preserve order and strict score ordering through Promises (test:289).
- `[C]` remove resolves true then false and the doc is gone (test:303).
- `[C]` a synchronous validation error becomes a Promise rejection matching `/Unknown/` (test:310).

### C.7 Search — SQLite-only (`search.test.ts:337-406`)

- `[B]` an indexed doc and its meta survive close + reopen (test:338).
- `[B]` a fielded schema survives close + reopen, still accepts weights, and still rejects a `text` doc (test:357).
- `[B]` a hand-built pre-schema single-`text` FTS database is adopted as the default `{text}` schema, rejects fielded docs, and accepts new `text` docs (test:375).

### C.8 Search — cross-backend parity (`search.test.ts:410-503`)

- `[C]` both backends return the same ranking order on the matcha fixture, with `high` first (test:411).
- `[C]` both backends return the same weighted field ranking, `["title-hit","body-hit"]` (test:437).
- `[C]` with an 80-token long field vs a 1-token short field and `{title:6, body:1}`, both backends put `title-short-body-long` first (test:460).
- `[C]` both backends return the same matching set for the two-term query `"fox brown"` (test:485).

`packages/store/src/sqlite-operations.test.ts` contains no vector or search assertions —
it covers connection inspection, transaction-scoped table caching, and WAL checkpoints.

---

## D. Node/JS-specific surfaces and their Python equivalents

The tokenizer's `/[\p{L}\p{N}]+/gu` needs Python's `regex` module (`regex.findall(r"[\p{L}\p{N}]+", s)`)
because the standard `re` module has no Unicode property classes; a pure-`re` fallback must
build the class from `unicodedata.category(ch)[0] in ("L","N")` per character, and note that
`\p{N}` covers `Nd`, `Nl` and `No`, so `\w` and `str.isalnum()` are both wrong substitutes.
`Float32Array` maps to `array.array("f")` or a NumPy `float32` array, and the crucial part is
that values are *rounded to float32 on assignment* — a Python port holding float64 values will
diverge on `isUsableVector` (a value that underflows to 0.0 in float32) and in the last digits
of every score, so round on write. `Buffer.writeFloatLE`/`readFloatLE` become `struct.pack("<f", x)` /
`struct.unpack_from("<f", buf, off)`, with `bufferToVector`'s `floor(byteLength/4)` truncation
reproduced explicitly. `JSON.stringify` is the load-bearing comparison inside `matchesWhere`,
and `json.dumps` differs from it: Python emits spaces after separators by default (use
`separators=(",",":")`), renders `True`/`None` correctly only through `json`, and does not
match JS on `NaN`/`Infinity` (JS emits `null`, Python emits `NaN` unless `allow_nan=False`);
key order is preserved by both, which the semantics depend on. `String.prototype.toLowerCase`
is close to `str.lower()` but not identical for a handful of code points, and `localeCompare`
used for id tie-breaks is ICU collation rather than code-point order — the SQLite backend
already uses code-point `BINARY` ordering there, so a Python port should use plain `<` on
strings and treat any corpus id set where the two disagree (case-mixed or non-ASCII ids) as
out of contract. Finally `hashName` iterates UTF-16 code units via `charCodeAt` with
`Math.imul` 32-bit wrapping, so a Python port must encode to UTF-16 code units
(`s.encode("utf-16-le")` read as 2-byte units) and mask to `0xFFFFFFFF` after each multiply.
