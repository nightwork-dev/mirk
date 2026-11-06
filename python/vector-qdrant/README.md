# mirk-vector-qdrant

A synchronous named-vector store over a host-owned official `QdrantClient`. Requires Qdrant 1.18+
and qdrant-client 1.19.1+. The stored format is shared with `@mirk/vector-qdrant`.

```python
from qdrant_client import QdrantClient
from mirk.vector_qdrant import QdrantVectorStore

client = QdrantClient(url="http://127.0.0.1:6333")
vectors = QdrantVectorStore(client, collection_name="app_vectors", namespace="default")
vectors.ensureSpace("text", {"dimensions": 3})
vectors.ensureSpace("image", {"dimensions": 2})
vectors.upsert(
    "assets",
    {
        "id": "one",
        "vectors": {"text": [1, 0, 0], "image": [0, 1]},
        "metadata": {"kind": "illustration"},
    },
)
hits = vectors.search("assets", {"space": "image", "vector": [0, 1]}, {"topK": 10})
```

Spaces are immutable within a namespace (default `default`), shared across logical collections.
`listSpaces()` returns name, dimensions, cosine metric and float32 encoding in code-point order.
`ensureSpace` raises `space-definition-conflict` for a conflicting definition. Unknown spaces and
wrong dimensions fail before a batch write. `upsert` replaces every vector and metadata on the
document; missing spaces are removed. `get` returns all named vectors; `count` counts documents;
`remove` removes the complete point. The old single-vector API and constructor dimension are removed.

Each space maps to a native named float32 Dot vector. Raw float32 bytes remain in payload; native
exact candidate prefixes are rescored using Mirk's float64 cosine function. Prefixes grow to preserve
membership and code-point ID ordering at ties. `page_size` (default 256) is the initial prefix.
`minScore` is inclusive. `where` matches its complete conjunction; `whereNot` excludes its complete
conjunction. Filters compare exact JSON text, including object-key order, before native ranking.
Absent metadata differs from an empty object. Zero queries score usable vectors at zero; stored
zero and non-finite vectors round-trip but do not appear as candidates. Missing selected spaces
omit a document. `meta` reports backend and acceleration, without global dimensions.

The host owns the client and physical collection. Writes/deletes wait for completion; transport,
authentication and backend failures propagate. Existing unnamed collections are never mutated by
an ordinary open.

## Legacy migration

Use one migration runner for each source and destination pair. Stop ordinary source and destination
writers until that runner finishes. Reserve a new destination for the copy. The completion marker
is not a lock, so resumptions must run one at a time:

```python
from mirk.vector_qdrant import migrateLegacyQdrantVectors

vectors = migrateLegacyQdrantVectors(
    client,
    source_collection_name="old_vectors",
    collection_name="named_vectors",
    page_size=256,
    on_progress=print,
)
```

The source is preserved. Legacy embeddings become the `default` space in the `default` namespace.
Progress includes `copied`, `total`, and `complete`. A durable marker prevents ordinary opening of
an interrupted destination. Repeat the same call to resume idempotently, with source and destination writers still
stopped. Completion checks document counts. Either language can resume the same copy. The caller
switches its configured physical collection after success; neither adapter deletes or swaps it.

The repository's `scripts/run-qdrant-tests.py` runs both languages on a temporary native server,
including shared vector scenarios and cross-language writes. Direct tests skip without
`MIRK_QDRANT_URL`.

Malformed legacy migration records raise `QdrantCollectionError`, a `ValueError` subclass. The
destination remains incomplete so the same copy can resume after the source record is repaired.
