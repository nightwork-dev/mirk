"""Named vector spaces on the shared SQLite format."""

from __future__ import annotations

import json
import sqlite3
from collections.abc import Generator
from contextlib import contextmanager
from typing import TYPE_CHECKING, Any, cast

from .filter import dumps_json
from .sqlite import connection_of, ensure_registry
from .vector import (
    VectorDocument,
    VectorInputError,
    VectorQuery,
    VectorSearchOptions,
    VectorSearchResult,
    VectorSearchResultList,
    VectorSpace,
    VectorSpaceOptions,
    VectorStoreMeta,
    assert_dimensions,
    bytes_to_vector,
    finish_search,
    keeps_metadata,
    min_score_of,
    score_of,
    to_float32,
    validate_space,
    vector_to_bytes,
)

if TYPE_CHECKING:
    from .sqlite_vec import SqliteVectorEngine

__all__ = ["SqliteVectorFacet", "connection_of"]


class SqliteVectorFacet:
    def __init__(
        self, db: sqlite3.Connection, *, path: str = "", namespace: str = "default", vector_engine: SqliteVectorEngine | None = None
    ) -> None:
        self._db = db
        self._namespace = namespace
        ensure_registry(db)
        self._engine = vector_engine
        if vector_engine is not None:
            vector_engine.initialize(db)

    @property
    def meta(self) -> VectorStoreMeta:
        return {"backend": "sqlite", "accelerated": self._engine is not None}

    @contextmanager
    def _write(self) -> Generator[None]:
        nested = self._db.in_transaction
        self._db.execute("SAVEPOINT mirk_vector" if nested else "BEGIN IMMEDIATE")
        try:
            yield
            self._db.execute("RELEASE SAVEPOINT mirk_vector" if nested else "COMMIT")
        except BaseException:
            self._db.execute("ROLLBACK TO SAVEPOINT mirk_vector" if nested else "ROLLBACK")
            if nested:
                self._db.execute("RELEASE SAVEPOINT mirk_vector")
            raise

    def _space(self, name: str) -> VectorSpace | None:
        row = self._db.execute(
            "SELECT dimensions,metric,encoding FROM _mirk_vector_spaces WHERE "
            "namespace=? AND name=?",
            (self._namespace, name),
        ).fetchone()
        if row is None:
            return None
        return {"name": name, "dimensions": int(row[0]), "metric": "cosine", "encoding": "float32"}

    def _require_space(self, name: str) -> VectorSpace:
        space = self._space(name)
        if space is None:
            raise VectorInputError("unknown-space", f"Unknown vector space: {name}")
        return space

    def ensureSpace(self, name: str, options: VectorSpaceOptions) -> None:
        validate_space(name, options)
        with self._write():
            space = self._space(name)
            if space is not None and space["dimensions"] != options["dimensions"]:
                raise VectorInputError(
                    "space-definition-conflict",
                    f"Space {name} already has {space['dimensions']} dimensions",
                )
            self._db.execute(
                "INSERT OR IGNORE INTO _mirk_vector_spaces VALUES(?,?,?,'cosine','float32')",
                (self._namespace, name, options["dimensions"]),
            )

    def listSpaces(self) -> list[VectorSpace]:
        names = self._db.execute(
            "SELECT name FROM _mirk_vector_spaces WHERE namespace=?", (self._namespace,)
        ).fetchall()
        return [self._require_space(row[0]) for row in sorted(names)]

    def _validate(self, doc: VectorDocument) -> None:
        if not doc["vectors"]:
            raise VectorInputError("empty-vectors", "A document needs at least one vector")
        for name, vector in doc["vectors"].items():
            assert_dimensions(vector, self._require_space(name)["dimensions"])

    def upsert(self, collection: str, doc: VectorDocument) -> None:
        self.upsertMany(collection, [doc])

    def upsertMany(self, collection: str, docs: list[VectorDocument]) -> None:
        with self._write():
            prepared: list[tuple[VectorDocument, str | None, dict[str, bytes]]] = []
            for doc in docs:
                self._validate(doc)
                metadata = doc.get("metadata")
                prepared.append(
                    (
                        doc,
                        None if metadata is None else dumps_json(metadata),
                        {name: vector_to_bytes(vector) for name, vector in doc["vectors"].items()},
                    )
                )
            for doc, metadata_json, vectors in prepared:
                self._db.execute(
                    "INSERT INTO _mirk_vector_documents VALUES(?,?,?,?) ON "
                    "CONFLICT(namespace,collection,id) DO UPDATE SET "
                    "metadata=excluded.metadata",
                    (self._namespace, collection, doc["id"], metadata_json),
                )
                self._db.execute(
                    "DELETE FROM _mirk_vector_values WHERE namespace=? AND collection=? AND id=?",
                    (self._namespace, collection, doc["id"]),
                )
                for name, blob in vectors.items():
                    self._db.execute(
                        "INSERT INTO _mirk_vector_values VALUES(?,?,?,?,?)",
                        (self._namespace, collection, doc["id"], name, blob),
                    )

    def get(self, collection: str, id: str) -> VectorDocument | None:
        row = self._db.execute(
            "SELECT metadata FROM _mirk_vector_documents WHERE namespace=? AND"
            " collection=? AND id=?",
            (self._namespace, collection, id),
        ).fetchone()
        if row is None:
            return None
        values = self._db.execute(
            "SELECT space,vec FROM _mirk_vector_values WHERE namespace=? AND collection=? AND id=?",
            (self._namespace, collection, id),
        ).fetchall()
        doc: VectorDocument = {
            "id": id,
            "vectors": {str(value[0]): bytes_to_vector(bytes(value[1])) for value in values},
        }
        if row[0] is not None:
            doc["metadata"] = cast(dict[str, Any], json.loads(row[0]))
        return doc

    def has(self, collection: str, id: str) -> bool:
        return self.get(collection, id) is not None

    def remove(self, collection: str, id: str) -> bool:
        with self._write():
            self._db.execute(
                "DELETE FROM _mirk_vector_values WHERE namespace=? AND collection=? AND id=?",
                (self._namespace, collection, id),
            )
            return (
                self._db.execute(
                    "DELETE FROM _mirk_vector_documents WHERE namespace=? AND "
                    "collection=? AND id=?",
                    (self._namespace, collection, id),
                ).rowcount
                > 0
            )

    def count(self, collection: str) -> int:
        return int(
            self._db.execute(
                "SELECT COUNT(*) FROM _mirk_vector_documents WHERE namespace=? AND collection=?",
                (self._namespace, collection),
            ).fetchone()[0]
        )

    def search(
        self, collection: str, query: VectorQuery, opts: VectorSearchOptions | None = None
    ) -> VectorSearchResultList:
        assert_dimensions(query["vector"], self._require_space(query["space"])["dimensions"])
        vector = to_float32(query["vector"])
        if self._engine is not None:
            return self._engine.search(self._db, self._namespace, collection, query["space"], vector, opts)
        rows = self._db.execute(
            "SELECT v.id,v.vec,d.metadata FROM _mirk_vector_values v JOIN "
            "_mirk_vector_documents d USING(namespace,collection,id) WHERE "
            "v.namespace=? AND v.collection=? AND v.space=?",
            (self._namespace, collection, query["space"]),
        ).fetchall()
        scored: VectorSearchResultList = []
        for row in rows:
            metadata = None if row[2] is None else cast(dict[str, Any], json.loads(row[2]))
            if not keeps_metadata(metadata, opts):
                continue
            score = score_of(vector, bytes_to_vector(bytes(row[1])), min_score_of(opts))
            if score is None:
                continue
            hit: VectorSearchResult = {"id": str(row[0]), "score": score}
            if metadata is not None:
                hit["metadata"] = metadata
            scored.append(hit)
        return finish_search(scored, opts)
