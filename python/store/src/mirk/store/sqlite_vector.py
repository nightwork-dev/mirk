"""SQLite vector facet: the ``vectors`` table the TypeScript adapter writes.

The facet shares one connection with :class:`~mirk.store.sqlite.SqliteStore`
rather than opening a second handle on the same file, so a write and its
metadata commit together.

One search path: the base table is scanned and scored in float64 Python cosine.
``meta["accelerated"]`` is therefore always False. A ``sqlite-vec`` (vec0) path
used to sit beside this one and never executed once; it was deleted under
roadmap MR-22, with the reasoning in
``docs/evidence/python-port/2026-09-02-vec0-branch-dead.md``. Legacy
``vectors_vec_*`` shadow tables in older files are left in place; they are inert.
"""

from __future__ import annotations

import json
import sqlite3
from collections.abc import Generator
from contextlib import contextmanager
from typing import Any, cast

from .filter import dumps_json
from .sqlite import connection_of
from .vector import (
    VectorDocument,
    VectorSearchOptions,
    VectorSearchResult,
    VectorSearchResultList,
    VectorStoreMeta,
    assert_dimensions,
    bytes_to_vector,
    finish_search,
    keeps_metadata,
    min_score_of,
    score_of,
    to_float32,
    vector_to_bytes,
)

__all__ = [
    "NO_DIMENSIONS_MESSAGE",
    "SqliteVectorFacet",
    "connection_of",
    "dimensions_conflict_message",
    "positive_dimensions_message",
]

NO_DIMENSIONS_MESSAGE = (
    "SqliteAdapter.vector has no dimensions yet"
    " — pass { dimensions } when opening or upsert a vector first."
)


def positive_dimensions_message(dimensions: object) -> str:
    return f"Vector dimensions must be a positive integer; got {dimensions}."


def dimensions_conflict_message(path: str, stored: int, opened: object) -> str:
    return f"Vector store at {path} was created with {stored} dimensions, opened with {opened}."


class SqliteVectorFacet:
    """The ``VectorStore`` port over one SQLite connection."""

    def __init__(
        self,
        db: sqlite3.Connection,
        *,
        path: str = "",
        dimensions: int | None = None,
    ) -> None:
        self._db = db
        self._path = path
        self._dimensions = -1
        db.executescript(
            """
            CREATE TABLE IF NOT EXISTS vectors (
              collection TEXT NOT NULL,
              id TEXT NOT NULL,
              vec BLOB NOT NULL,
              metadata TEXT,
              PRIMARY KEY (collection, id)
            );
            CREATE INDEX IF NOT EXISTS vectors_collection ON vectors(collection);
            CREATE TABLE IF NOT EXISTS _vec_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            """
        )
        row = db.execute("SELECT value FROM _vec_meta WHERE key = 'dimensions'").fetchone()
        if row is not None:
            self._dimensions = int(row[0])
            if dimensions is not None and dimensions != self._dimensions:
                raise ValueError(dimensions_conflict_message(path, self._dimensions, dimensions))
        elif dimensions is not None:
            self.configure_dimensions(dimensions)

    # ── Dimensions ───────────────────────────────────────────────────────
    def configure_dimensions(self, dimensions: int) -> None:
        """Establish dimensions, persisting them. A conflicting value raises."""
        if dimensions <= 0 or dimensions != int(dimensions):
            raise ValueError(positive_dimensions_message(dimensions))
        if self._dimensions >= 0:
            if dimensions != self._dimensions:
                raise ValueError(
                    dimensions_conflict_message(self._path, self._dimensions, dimensions)
                )
            return
        self._dimensions = dimensions
        self._db.execute(
            "INSERT INTO _vec_meta (key, value) VALUES ('dimensions', ?)"
            " ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (str(dimensions),),
        )

    @property
    def meta(self) -> VectorStoreMeta:
        return {
            "backend": "sqlite",
            "dimensions": max(self._dimensions, 0),
            "accelerated": False,
        }

    @property
    def dimensions(self) -> int:
        """The configured dimensions, or 0 while none are known."""
        return max(self._dimensions, 0)

    def _require_known_dims(self, vector: list[float]) -> None:
        if self._dimensions < 0:
            raise ValueError(NO_DIMENSIONS_MESSAGE)
        assert_dimensions(vector, self._dimensions)

    def _ensure_dims_for_write(self, vector: list[float]) -> None:
        if self._dimensions < 0:
            self.configure_dimensions(len(vector))
        assert_dimensions(vector, self._dimensions)

    # ── Transactions ─────────────────────────────────────────────────────
    @contextmanager
    def _write(self) -> Generator[None]:
        """One outermost transaction; a nested call joins the open one."""
        if self._db.in_transaction:
            yield
            return
        self._db.execute("BEGIN IMMEDIATE")
        try:
            yield
        except BaseException:
            self._db.execute("ROLLBACK")
            raise
        else:
            self._db.execute("COMMIT")

    # ── Writes ───────────────────────────────────────────────────────────
    def upsert(self, collection: str, doc: VectorDocument) -> None:
        self._ensure_dims_for_write(doc["vector"])
        rounded = to_float32(doc["vector"])
        metadata = doc.get("metadata")
        with self._write():
            self._db.execute(
                "INSERT INTO vectors(collection, id, vec, metadata) VALUES (?, ?, ?, ?)"
                " ON CONFLICT(collection, id)"
                " DO UPDATE SET vec = excluded.vec, metadata = excluded.metadata",
                (
                    collection,
                    doc["id"],
                    vector_to_bytes(rounded),
                    None if metadata is None else dumps_json(metadata),
                ),
            )

    def upsertMany(self, collection: str, docs: list[VectorDocument]) -> None:
        if not docs:
            return
        dimensions = self._dimensions if self._dimensions >= 0 else len(docs[0]["vector"])
        if dimensions <= 0:
            raise ValueError(positive_dimensions_message(dimensions))
        # Validate everything before establishing lazy dimensions, so a mid-array
        # mismatch leaves neither rows nor a dimension behind.
        for doc in docs:
            assert_dimensions(doc["vector"], dimensions)
        if self._dimensions < 0:
            self.configure_dimensions(dimensions)
        with self._write():
            for doc in docs:
                self.upsert(collection, doc)

    def remove(self, collection: str, id: str) -> bool:
        with self._write():
            cursor = self._db.execute(
                "DELETE FROM vectors WHERE collection = ? AND id = ?", (collection, id)
            )
            return cursor.rowcount > 0

    # ── Reads ────────────────────────────────────────────────────────────
    def get(self, collection: str, id: str) -> VectorDocument | None:
        row = self._db.execute(
            "SELECT id, vec, metadata FROM vectors WHERE collection = ? AND id = ?",
            (collection, id),
        ).fetchone()
        if row is None:
            return None
        doc: VectorDocument = {"id": str(row[0]), "vector": bytes_to_vector(bytes(row[1]))}
        if row[2] is not None:
            doc["metadata"] = cast(dict[str, Any], json.loads(row[2]))
        return doc

    def has(self, collection: str, id: str) -> bool:
        row = self._db.execute(
            "SELECT 1 FROM vectors WHERE collection = ? AND id = ?", (collection, id)
        ).fetchone()
        return row is not None

    def count(self, collection: str) -> int:
        row = self._db.execute(
            "SELECT COUNT(*) FROM vectors WHERE collection = ?", (collection,)
        ).fetchone()
        return int(row[0])

    def search(
        self, collection: str, query: list[float], opts: VectorSearchOptions | None = None
    ) -> VectorSearchResultList:
        self._require_known_dims(query)
        rounded = to_float32(query)
        return self._search_js(collection, rounded, opts)

    def _search_js(
        self, collection: str, query: list[float], opts: VectorSearchOptions | None
    ) -> VectorSearchResultList:
        minimum = min_score_of(opts)
        rows = self._db.execute(
            "SELECT id, vec, metadata FROM vectors WHERE collection = ?", (collection,)
        ).fetchall()
        scored: VectorSearchResultList = []
        for row in rows:
            metadata = None if row[2] is None else cast(dict[str, Any], json.loads(row[2]))
            if not keeps_metadata(metadata, opts):
                continue
            score = score_of(query, bytes_to_vector(bytes(row[1])), minimum)
            if score is None:
                continue
            hit: VectorSearchResult = {"id": str(row[0]), "score": score}
            if metadata is not None:
                hit["metadata"] = metadata
            scored.append(hit)
        return finish_search(scored, opts)
