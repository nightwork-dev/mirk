# mirk-vector-qdrant

`mirk-vector-qdrant` provides a synchronous `mirk.store.vector.VectorStore`
adapter over an injected official `qdrant-client` `QdrantClient`.

```python
from qdrant_client import QdrantClient

from mirk.vector_qdrant import QdrantVectorStore

client = QdrantClient(url="http://127.0.0.1:6333")
vectors = QdrantVectorStore(
    client,
    collection_name="mirk_vectors",
    dimensions=3,
)
embedding = [0.25, 0.5, 0.75]
vectors.upsert(
    "documents",
    {"id": "one", "vector": embedding, "metadata": {"kind": "note"}},
)
hits = vectors.search("documents", embedding, {"topK": 10, "where": {"kind": "note"}})
```

The adapter owns a dedicated physical Qdrant collection selected by the host.
The `collection` argument on each vector operation is a logical scope stored in
the payload, so several scopes can share that physical collection. The adapter
creates the collection when it is missing and validates its unnamed float32 vector size,
`Dot` distance, and reserved payload indexes before writing.

Stored vectors retain their original little-endian float32 bytes in payload.
Qdrant indexes a float32-normalized copy with `Dot`; search requests native exact
candidates, rescoring them with Mirk's float64 cosine implementation before
returning results. `where` and `whereNot` use exact JSON text terms, including
object key order and array order. `minScore` is applied after rescoring and is
inclusive. `page_size` sets the initial candidate count. Search grows this count
when rounding differences or cutoff ties can affect the result; it does not cap results.

When many points share the cutoff score, completion reads all tied candidates,
including ties beyond the initial candidate count, before applying `topK`. This is required for
the deterministic score-descending, Unicode-codepoint id order promised by the
Mirk vector port.

The host owns the `QdrantClient` lifecycle and the physical collection. The
adapter waits for all upserts and deletes to complete and propagates transport,
authentication, and backend errors.
