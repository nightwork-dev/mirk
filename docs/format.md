# Mirk SQLite format

This is the normative storage contract for independent SQLite readers and writers. The current
core format is **4**. Package versions, core file versions, coordination versions, and jobs record
versions are separate numbers. The checked-in [schemas and golden files](../testdata/sqlite-format/)
provide historical examples. They supplement this document; they are not templates to upgrade in place.

## Version admission and evolution

A versioned core file has `_mirk_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL)`. Exactly one row
has `key='schema_version'`. Its value is the canonical positive decimal TEXT spelling of the core
version, for example `'4'`. It is not `PRAGMA user_version`, a package version, or a SQLite engine
version. Other metadata keys do not replace this row.

Readers must declare the core versions they understand. Read and validate the marker before
interpreting version-dependent tables. Reject a newer or unsupported version before changing the
file or interpreting its payloads. Reject malformed or inconsistent metadata. Opening a file with
an older reader never downgrades it. A reader pinned to version 2 must refuse versions 3 and 4,
even if it only wants one unchanged KV table.

A missing marker does not mean version 1. Only a recognized historical unversioned layout can be
adopted. Unknown tables or a guessed package age do not establish its format. An independent
reader can refuse unversioned files altogether. An empty SQLite database is not an existing Mirk
store merely because it can be initialized as one.

| Historical layout | Evidence and interpretation |
| --- | --- |
| Unversioned legacy | Source `5aa4088e536e5d525632fd1d5b0a946652b058f9`, before the registry change. Hash-derived collection/search names, ordinary vectors and atomic tables existed without `_mirk_meta` or `_mirk_tables`. |
| Core 1 | No writer emitting marker 1 was found in the inspected Git history. Migration admission accepts 1 as compatibility input. There is no invented version-1 schema or golden. A reader supporting only evidenced layouts must refuse it. |
| Core 2, early | Commit `36f0c9b8210026a990a48ec04800d593b9e1f1ca` introduced the marker **2** and registry together. Receipts had three columns, without `created_at`. |
| Core 2, later | Snapshot `e746b39269b85e905611377391f94601d20a0e9c` includes log storage, declared expression indexes, and nullable receipt `created_at`. These additions historically retained marker 2. Both receipt shapes must be considered when reading historical files. |
| Core 3 | Snapshot `ddeeac88663eda7b54e9bfb7c38ccbb3251ab81f` replaces legacy vectors with namespace/space/document/value tables. Log rows still have no persistent stream generation. |
| Core 4 | Keeps named vectors and adds durable log generations. The eager log layout is defined by `sql-log-format.ts`, introduced in `9480bf2fc3d81cce3a1c9ce348c20201a94e51e4`. Policy snapshot `441f6ff271a01b70d2ce90b039ad885611f5ec7a` commits marker 4 after log and receipt migration. Existing receipt tables acquire missing `created_at` before that marker is committed. |

The historical additions under marker 2 are facts about old files, not permission to repeat that
practice. From this contract onward, adding, removing, or changing a canonical column requires a
core version bump. This includes an additive nullable column. Changing a canonical table, its keys, encoding, constraints, or core persisted meaning also
requires a bump and an explicit migration.

Version-preserving schema and maintenance changes are limited to ordinary indexes that do not
change stored semantics,
application-owned tables outside Mirk's reserved names, and SQLite maintenance such as checkpoint,
backup, `VACUUM`, or page-size/journal changes. Engine-owned FTS shadow storage follows SQLite's
FTS5 implementation. It is not an application serialization format. A separately versioned
component can evolve under its own documented marker; it must not reinterpret core tables.
Ordinary mutations through existing port contracts do not change the core version. Application
JSON records can evolve under their own schema version without changing the core JSON encoding.

Migration holds writer admission, rechecks the marker after admission, validates and copies old
data, and writes the new marker last. Failure must roll back the migration. A read-only reader
never migrates. Migrations preserve application tables, row order, atomic identities, versions,
receipts, vector bytes, and log records. Legacy vectors become one explicitly selected space in
namespace `default`; its default name is `default`. The migration controls and backup options are
documented in the [TypeScript](../packages/store/README.md#shared-sqlite-file-format) and
[Python](../python/store/README.md#shared-sqlite-file-format) package contracts.

## Common representation and schema

The following layouts describe ordinary SQLite tables. `TEXT`, `INTEGER`, `BLOB`, and declared
`JSON` are SQLite affinity declarations, not STRICT-table types. `NN` means an explicit `NOT NULL`.
A `TEXT PRIMARY KEY` in an ordinary rowid table does not itself add SQLite's `NOT NULL` constraint.
The APIs nevertheless require string keys and IDs. Do not use that historical DDL quirk to write
SQL NULL identities. Composite-key columns below are explicitly NN unless stated otherwise.

Files use SQLite's UTF-8 text encoding. JSON columns contain JSON **text**, never SQLite JSONB or
language-specific object serialization. SQL NULL metadata means absent; JSON `{}` means a present
empty object. JSON `null` is a value and does not mean a missing field. Preserve object key order
when retaining encoded values: exact JSON metadata comparisons can depend on it.

Stored JSON strings preserve escaped lone UTF-16 surrogates as values, for example `"\ud800"`.
A Rust `String` is not a lossless replacement for that decoded string model. A reader must either
preserve such escapes/code units, use a compatible representation, or explicitly reject that value.
It must not silently replace it with U+FFFD. Lone surrogates are **not** portable SQL TEXT
identifiers: keys, record IDs, collection names, and bound filter values require valid Unicode
scalar strings for cross-language operation. The source adapters do not add an identity escape codec.

Portable JSON numbers have JavaScript binary64 semantics. Integers beyond the exact safe-integer
range are not portable arbitrary-precision integers. Python normalizes numbers to the shared
representation, including integral floats. JSON distinguishes booleans from numbers. Atomic and
log writes reject non-finite JSON numbers. Ordinary TypeScript JSON serialization can normalize
unsupported values where the individual port allows it; such normalization is not a new on-disk
number encoding. Binary vectors independently permit non-finite float32 components.

| Table | Exact columns and keys | Presence and meaning |
| --- | --- | --- |
| `_mirk_meta` | `key TEXT PRIMARY KEY`, `value TEXT NN` | Required in versioned files. Marker row as above. |
| `_mirk_tables` | `kind TEXT NN`, `name TEXT NN`, `table_name TEXT NN UNIQUE`, PK `(kind,name)` | Required since 2. Global physical-name uniqueness across kinds. |
| `_kv` | `key TEXT PRIMARY KEY`, `value TEXT NN`, `created_at TEXT DEFAULT(datetime('now'))`, `updated_at TEXT DEFAULT(datetime('now'))` | KV capability. Value is JSON text. Timestamps are nullable UTC SQLite datetime text, not version tokens. |
| Resolved collection table | `id TEXT PRIMARY KEY`, `data JSON NN`, same nullable `created_at` and `updated_at` columns as `_kv` | Created when a collection is used. `data` is the complete JSON record, including its string `id`. |
| `_mirk_atomic_versions` | `kind TEXT NN`, `collection TEXT NN`, `target_key TEXT NN`, `version TEXT NN`, PK `(kind,collection,target_key)` | Current token for an existing key or record. |
| `_mirk_atomic_identity` | `id INTEGER PRIMARY KEY CHECK(id=1)`, `value TEXT NN` | Exactly one singleton. Stable store identity. |
| `_mirk_atomic_sequence` | `id INTEGER PRIMARY KEY CHECK(id=1)`, `value INTEGER NN` | Exactly one singleton. Monotonic token allocation counter, initially 0. |
| `_mirk_atomic_receipts` | `idempotency_key TEXT PRIMARY KEY`, `request_digest TEXT NN`, `result_json TEXT NN`, `created_at INTEGER` | Receipt time is nullable epoch milliseconds. Early historical 2 lacks this column. Canonical 4 includes it whenever this capability table exists. |

Capability tables can be absent in a file used by a narrower adapter. For example, libSQL need not
create local search tables, and collection/search data tables are lazy. Such absence means that
facet has no stored data; it does not authorize a reader to invent rows. Core 3 requires the three
named-vector tables even when empty. Core 4 additionally requires all three log tables even when
empty. The full local source adapter initializes KV, atomic, and search-schema capabilities when
opened. A smaller capability-specific reader must not infer that every optional table is present.

### Collection registry and ordering

Registry `kind` values are `collection` and `search`. Read the registry mapping, not a guessed
hash, for a registered collection. Search rows map to the docs table; its FTS table is derived from
that same mapping. A registry row remains meaningful when its collection currently has zero rows.

The legacy candidate is `<prefix><sanitized-name>_<hash>`. Collection prefix is `c_`; search docs
prefix is `search_docs_`. Sanitization replaces each character outside ASCII letters, digits, and
underscore with `_`. The hash is 32-bit FNV-1a over UTF-16 code units, using offset 2166136261,
XOR then multiplication by 16777619 modulo 2^32, rendered as unsigned lower-case base36.
A hash can collide. The registry, not the hash, establishes identity.

Resolution first uses an existing `(kind,name)` mapping. Otherwise it adopts an unclaimed exact
legacy candidate, including an existing pre-registry table there. A collision takes suffix `_2`,
then `_3`, and so on. An existing unclaimed suffixed table is never adopted for a new logical name.
Registration is transactional. Read paths must not mint registry rows for unknown collections.
LibSQL can prepend its validated `tablePrefix` to core and resolved table names. An independent
reader must receive that prefix explicitly; the unprefixed golden files do not exercise this option.

Unsorted collection iteration is insertion order, represented by `rowid`. Updates to an existing
ID preserve its rowid. Deleting and reinserting it creates a new insertion position. Sorted results
use the requested field, put null/missing values last, and retain insertion order at ties. A migration
must not rebuild these tables in an order that changes this behavior. IDs and KV keys are strings,
not integers to parse from their spelling. KV keys and record IDs can be empty; collection names
and log stream names cannot. JSON record IDs and the table's `id` must identify the same record.

Declared field indexes are ordinary expression indexes over
`json_extract(data, '<quoted JSON path>')`. Current index names are
`ix_<physical-table>_<hex-of-UTF8-path-label>`. The path label follows JSON string escaping, with
quotes represented as `\u0022` for SQLite/libSQL compatibility. An index is derived access
structure. Its absence changes performance, not record identity or ordering, and adding it does
not require a core version bump. Independent writers must retain the rows and registry even when
they cannot use that index.

### Atomic versions and receipts

Version targets use `kind='key'`, `collection=''`, `target_key=<KV key>` or `kind='record'`,
`collection=<logical collection>`, `target_key=<record id>`. A token is opaque to callers.
Current writers mint `<identity>-v<counter>`, after incrementing the singleton counter. Preserve
existing token text and identity. Do not reset or compact the counter when deleting records.
Deletes remove current target-version rows; retained receipts can still mention old tokens. Legacy
records can lack a current version row. A versioned API read can backfill one; an independent
read-only reader must not manufacture or persist that token.

SQLite stores the counter as a signed 64-bit integer. Cross-language writes must stay within the
exact binary64 integer range, 0 through 9007199254740991. The historical DDL does not enforce this
upper bound. Values outside the shared runtime range are not a portable token-allocation promise.

A receipt binds its scoped idempotency key to `request_digest`, the lower-case SHA-256 of the UTF-8
canonical atomic request. The digest input schema is `mirk-atomic-request/v1`, with normalized
`conditions`, `operations`, and optional `outcome`. The idempotency key itself is excluded.
Canonical object keys use Unicode code-point order, arrays retain order, and numbers follow
JavaScript JSON spelling. Ordinary stored JSON is not thereby required to sort its object keys.
`result_json` stores the full applied atomic result, including request digest, target versions,
and optional outcome. Replays retain those historical versions. They do not assert present ownership.

Receipt `created_at` is an optional historical timestamp, not a new identity. SQL NULL denotes an
unstamped legacy receipt. Retention is disabled unless configured. The expiry operation can stamp
legacy NULL timestamps before applying retention. The ordinary
`_mirk_atomic_receipts_created_at` index serves that operation. An independent reader must not
expire or remove receipts merely because their timestamps are old.

### Search and FTS5

`_mirk_search_schema(collection TEXT PRIMARY KEY, fields_json TEXT NN)` records the stable ordered
field-name array for each indexed logical collection. An older existing docs table without a schema
row can be recognized as the single default `text` field. This historical compatibility case does
not permit arbitrary changes to the field set after indexing.

A resolved search docs table contains `id TEXT PRIMARY KEY`, one `TEXT NN` column per field,
and nullable `meta_json TEXT`. The default field uses column `text`. Other fields use
`f<zero-based-field-index>_<FNV32-base36(field)>`. Preserve the ordered field list; column names
alone cannot reconstruct original field names safely.

The FTS table replaces the leading `search_docs_` prefix with `search_fts_`, retaining any collision
suffix. It is `fts5(<ordered columns>, content='<docs-table>', content_rowid='rowid',
tokenize='unicode61')`. The docs table is the external-content authority. Its `<docs>_ai`,
`<docs>_ad`, and `<docs>_au` triggers insert new rows, issue FTS5's special `delete` rows on deletion,
and delete-old/insert-new on updates. The [golden generator](../scripts/generate-sqlite-format-goldens.py) includes the complete
static trigger pattern alongside the historical schema snapshots.

FTS5, including the `unicode61` tokenizer and BM25 support, is required to query or update this
index correctly. JSON1 is required for collection expression indexes and SQL JSON filtering.
Do not interpret FTS shadow tables as application rows or alter them independently. Search scores
are computed, not persisted. Optional sqlite-vec uses the canonical vector BLOBs; it does not add a
second canonical vector representation or a language-specific file version.

### Vectors before and after format 3

Before 3, `vectors` has `collection TEXT NN`, `id TEXT NN`, `vec BLOB NN`, nullable `metadata TEXT`,
PK `(collection,id)`, and ordinary index `vectors_collection(collection)`.
`_vec_meta(key TEXT PRIMARY KEY,value TEXT NN)` stores dimension under key `dimensions` as positive
decimal text. An empty legacy store can lack that row. A recognized nonempty older file can infer
one consistent dimension from its BLOB lengths during migration. There is no implicit second
vector space or per-document dimension change. Inert historical sqlite-vec `vec0` shadow tables
are not canonical source data and are not required by an independent reader.

| Format 3 and 4 table | Exact columns and constraints |
| --- | --- |
| `_mirk_vector_spaces` | `namespace TEXT NN`, `name TEXT NN`, `dimensions INTEGER NN CHECK(dimensions>0)`, `metric TEXT NN CHECK(metric='cosine')`, `encoding TEXT NN CHECK(encoding='float32')`, PK `(namespace,name)` |
| `_mirk_vector_documents` | `namespace TEXT NN`, `collection TEXT NN`, `id TEXT NN`, nullable `metadata TEXT`, PK `(namespace,collection,id)` |
| `_mirk_vector_values` | `namespace TEXT NN`, `collection TEXT NN`, `id TEXT NN`, `space TEXT NN`, `vec BLOB NN`, PK `(namespace,collection,id,space)` |

The values table references document `(namespace,collection,id)` with `ON DELETE CASCADE` and
space `(namespace,name)` through `(namespace,space)`. Writers must enforce both references.
Enable foreign keys on writing connections. Namespace defaults to the literal string `default`.
Space names are nonempty. Definitions are shared across collections within a namespace and are
immutable. A document has a nonempty vector map and can omit known spaces. Complete replacement
removes omitted vectors. Count documents, not embedding rows.

Every vector BLOB is exactly `dimensions * 4` bytes. Components are IEEE-754 binary32 in
**little-endian** order, without a header, dimension prefix, padding, or native-library trailer.
`[1,-2,0.5]` is hex `0000803f000000c00000003f`. A BLOB length inconsistent with its space is malformed.
SQL NULL metadata differs from JSON `{}`. Zero and non-finite components remain storable; their
search exclusion is a port behavior, not permission to rewrite the bits during migration.

### Log generations in format 4

Formats 2 and 3 can contain `_mirk_log(stream TEXT NN, sequence INTEGER NN CHECK(sequence>=1),
record TEXT NN, PRIMARY KEY(stream,sequence)) WITHOUT ROWID`. A record is JSON text. Sequence is
positive and is the per-stream append order. The old layout has no durable stream-incarnation
identifier. Deletion/recreation under the old sequence-only API can reuse sequence numbers.

Format 4 keeps that table unchanged and eagerly creates:

| Table | Exact columns and constraints |
| --- | --- |
| `_mirk_log_generation` | `id INTEGER PRIMARY KEY CHECK(id=1)`, `value INTEGER NN CHECK(value>=0 AND value<=9007199254740991)`; one row `(1,0)` initially |
| `_mirk_log_streams` | `stream TEXT PRIMARY KEY`, `generation INTEGER NN UNIQUE CHECK(generation>=1 AND generation<=9007199254740991)`; `WITHOUT ROWID` |

`_mirk_log_streams` maps only live streams. A first append allocates the singleton's next generation
and inserts that registry row in the same transaction as sequence 1. Deleting a stream removes its
entries and live row together, preserving the singleton. Recreating its name gets a larger generation.
There is no per-deleted-stream tombstone table. Stored generations and API sequences stay within
positive safe integers. Exhaustion must not wrap or reuse an old generation.

A cursor is `{generation,sequence}`. It names one incarnation, not merely a position under a reused
stream name. A stale generation or a cursor for a missing stream is refused. Migration assigns
existing live streams generations 1 through N in SQLite `BINARY` stream order with `ROW_NUMBER`,
preserves their records and sequence values, and sets the singleton to the largest assigned value.
The live registry and entries must agree; a generation is never inferred from wall time.

## Independent components and immutable examples

Coordination has its own version **1**, even in a standalone database without core metadata.
`_mirk_coordination_meta(schema_version INTEGER NN)` has exactly one row with value 1. The other
tables are ordinary rowid tables:

- `_mirk_coordination_generations(namespace TEXT NN,key TEXT NN,last_generation INTEGER NN)`,
  PK `(namespace,key)`. History survives lease release. Generations are positive safe integers.
- `_mirk_coordination_leases(namespace TEXT NN,key TEXT NN,owner_token TEXT NN,
  fencing_generation INTEGER NN,acquired_at_ms INTEGER NN,expires_at_ms INTEGER NN,
  updated_at_ms INTEGER NN)`, PK `(namespace,key)`. Times are epoch milliseconds. A lease generation
  cannot exceed its recorded generation history. Core migration preserves these component tables.

Jobs are ordinary KV/collection JSON records, not a new SQLite table layout. New jobs records have
`schemaVersion: 2`, adding nullable `activeKey`, `subject`, and `kind` to record version 1. Valid
version-1 records and retained outcomes normalize those fields to null on read without rewriting
the backing record or changing its KV version. A later mutation writes record version 2. Active
slots use ordinary KV key `mirk-jobs-active:` plus canonical JSON `[jobsCollection,queue,key]`, with
a job-ID string value. This record version and namespace do not replace or bump the core marker.
See the [jobs contract](../packages/jobs/README.md) for lifecycle and receipt rules.

The immutable fixtures cover recognized unversioned legacy, both evidenced historical version-2
receipt layouts, version 3, and version 4. Each includes KV, ordered collection records, search docs
and FTS index, vectors, atomic identity/current versions/receipt, and Unicode JSON values. Later
fixtures add declared field indexes and log history; 4 includes a live generation after earlier
generations were retired. SQL NULL vector metadata and JSON `{}` are both represented. Application
rows demonstrate that unrelated data can coexist.

The [manifest](../testdata/sqlite-format/manifest.json) records file SHA-256, schema
SHA-256, source revision, generator SQLite version, and full expected logical contents. Files are
seeded from static historical DDL, not opened by the current adapter. They are never regenerated
at test startup, automatically migrated in place, or overwritten by the generator.

```sh
python3 scripts/test-sqlite-format-goldens.py
python3 scripts/generate-sqlite-format-goldens.py --out /tmp/new-format-goldens
```

Regeneration requires a new empty destination. Compare logical contents across SQLite engine
versions; byte identity is expected with the same generator and SQLite version. Changing the
checked-in historical files or their hashes is an explicit fixture replacement, not routine test
maintenance. Preserve old files when adding a new format.

The [minimal Rust reader](../examples/sqlite-format-reader/reader.rs) links only system SQLite. It
opens read-only, accepts marker 2, decodes a selected legacy BLOB with `f32::from_le_bytes`, and
refuses 3 and 4 before querying version-dependent vector tables. It is a partial reader example,
not a Rust Mirk port. It returns raw JSON UTF-8 as hex with `json_decoded:false`; it does not claim
that Rust `String` can decode lone surrogate JSON losslessly. The Python and Node inspectors do
parse those JSON values and compare the same logical contents. Tests hash every golden before and
after all readers, including refusal paths. Rust execution is explicitly skipped when no `rustc`
is installed; it is never counted as proof in that case.
