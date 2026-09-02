"""SQLite vector facet: the ``vectors`` table the TypeScript adapter writes.

The facet shares one connection with :class:`~mirk.store.sqlite.SqliteStore`
rather than opening a second handle on the same file, so a write and its vec0
mirror commit together.

Two search paths, one result. When ``sqlite-vec`` loads, a per-collection vec0
table answers the k-nearest query; otherwise the base table is scanned and
scored in Python. Both paths exclude directionless vectors, apply ``minScore``
before cutting to ``topK``, and sort by score then id, so which one ran is not
observable in the results.
"""

from __future__ import annotations

import json
import re
import sqlite3
from collections.abc import Generator
from contextlib import contextmanager
from typing import Any, cast

from .filter import dumps_json
from .sqlite import connection_of, hash_name
from .vector import (
    VectorDocument,
    VectorSearchOptions,
    VectorSearchResult,
    VectorSearchResultList,
    VectorStoreMeta,
    assert_dimensions,
    bytes_to_vector,
    finish_search,
    is_usable_vector,
    keeps_metadata,
    min_score_of,
    score_of,
    to_float32,
    top_k_of,
    vector_to_bytes,
)

__all__ = [
    "NO_DIMENSIONS_MESSAGE",
    "SqliteVectorFacet",
    "connection_of",
    "dimensions_conflict_message",
    "positive_dimensions_message",
    "try_load_sqlite_vec",
]

_UNSAFE_TABLE_CHARS = re.compile(r"[^a-zA-Z0-9_]")

NO_DIMENSIONS_MESSAGE = (
    "SqliteAdapter.vector has no dimensions yet"
    " — pass { dimensions } when opening or upsert a vector first."
)


def positive_dimensions_message(dimensions: object) -> str:
    return f"Vector dimensions must be a positive integer; got {dimensions}."


def dimensions_conflict_message(path: str, stored: int, opened: object) -> str:
    return f"Vector store at {path} was created with {stored} dimensions, opened with {opened}."


def try_load_sqlite_vec(db: sqlite3.Connection) -> bool:
    """Load the optional ``sqlite-vec`` extension. False on any failure.

    Not installed, no extension support in this Python build, or a loader error
    all mean the same thing to the caller: take the exact path instead.
    """
    try:
        from importlib import import_module

        module: Any = import_module("sqlite_vec")
        loader: Any = getattr(module, "load", None)
        if not callable(loader):
            return False
        db.enable_load_extension(True)
        try:
            loader(db)
        finally:
            db.enable_load_extension(False)
        return True
    except Exception:
        return False


class SqliteVectorFacet:
    """The ``VectorStore`` port over one SQLite connection."""

    def __init__(
        self,
        db: sqlite3.Connection,
        *,
        path: str = "",
        dimensions: int | None = None,
        force_js_cosine: bool = False,
    ) -> None:
        self._db = db
        self._path = path
        self._dimensions = -1
        self._accelerated = False
        self._force_js_cosine = force_js_cosine
        self._vec_tables: set[str] = set()
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
            self._refresh_meta()
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
        self._refresh_meta()

    def _refresh_meta(self) -> None:
        self._accelerated = (
            not self._force_js_cosine and self._dimensions >= 0 and try_load_sqlite_vec(self._db)
        )

    @property
    def meta(self) -> VectorStoreMeta:
        return {
            "backend": "sqlite",
            "dimensions": max(self._dimensions, 0),
            "accelerated": self._accelerated,
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

    # ── vec0 mirror ──────────────────────────────────────────────────────
    def _vec_table_name(self, collection: str) -> str:
        sanitized = _UNSAFE_TABLE_CHARS.sub("_", collection)
        return f"vectors_vec_{sanitized}_{hash_name(collection)}"

    def _ensure_vec_table(self, collection: str) -> str:
        table = self._vec_table_name(collection)
        if table in self._vec_tables:
            return table
        # cosine, not vec0's L2 default, or the rankings would not match the
        # exact path.
        self._db.execute(
            f"CREATE VIRTUAL TABLE IF NOT EXISTS {table}"
            f" USING vec0(embedding float[{self._dimensions}] distance_metric=cosine)"
        )
        self._vec_tables.add(table)
        # Backfill rows written while the extension was unavailable, so an
        # accelerated search over an older file is still complete.
        existing = self._db.execute(
            "SELECT rowid, vec FROM vectors WHERE collection = ?", (collection,)
        ).fetchall()
        if existing:
            with self._write():
                for rowid, blob in existing:
                    self._db.execute(f"DELETE FROM {table} WHERE rowid = ?", (rowid,))
                    if is_usable_vector(bytes_to_vector(bytes(blob))):
                        self._db.execute(
                            f"INSERT INTO {table}(rowid, embedding) VALUES (?, ?)",
                            (rowid, bytes(blob)),
                        )
        return table

    def _sync_vec(self, collection: str, id: str, vector: list[float]) -> None:
        table = self._ensure_vec_table(collection)
        row = self._db.execute(
            "SELECT rowid FROM vectors WHERE collection = ? AND id = ?", (collection, id)
        ).fetchone()
        if row is None:
            return
        rowid = int(row[0])
        self._db.execute(f"DELETE FROM {table} WHERE rowid = ?", (rowid,))
        # A directionless vector stays out of vec0, so both paths exclude it.
        if is_usable_vector(vector):
            self._db.execute(
                f"INSERT INTO {table}(rowid, embedding) VALUES (?, ?)",
                (rowid, vector_to_bytes(vector)),
            )

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
            if self._accelerated:
                self._sync_vec(collection, doc["id"], rounded)

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
            if self._accelerated:
                row = self._db.execute(
                    "SELECT rowid FROM vectors WHERE collection = ? AND id = ?",
                    (collection, id),
                ).fetchone()
                if row is not None:
                    table = self._ensure_vec_table(collection)
                    self._db.execute(f"DELETE FROM {table} WHERE rowid = ?", (int(row[0]),))
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
        where = opts.get("where") if opts else None
        where_not = opts.get("whereNot") if opts else None
        has_filters = where is not None or where_not is not None
        # Metadata lives on the base table, not in vec0, so a pre-KNN filter has
        # to scan. A directionless query has no vec0 answer worth trusting.
        if self._accelerated and is_usable_vector(rounded) and not has_filters:
            try:
                return self._search_vec(collection, rounded, opts)
            except Exception:
                pass
        return self._search_js(collection, rounded, opts)

    def _search_vec(
        self, collection: str, query: list[float], opts: VectorSearchOptions | None
    ) -> VectorSearchResultList:
        table = self._ensure_vec_table(collection)
        minimum = min_score_of(opts)
        top_k = top_k_of(opts)
        # vec0 needs a k. When minScore can reject a near neighbour, k must cover
        # the collection or the floor would be applied to an already-cut list and
        # return fewer rows than the exact path.
        k = top_k if (minimum is None and top_k > 0) else max(1, self.count(collection))
        rows = self._db.execute(
            f"SELECT v.id, v.metadata, vv.distance FROM {table} vv"
            " JOIN vectors v ON v.rowid = vv.rowid"
            " WHERE vv.embedding MATCH ? ORDER BY vv.distance LIMIT ?",
            (vector_to_bytes(query), k),
        ).fetchall()
        scored: VectorSearchResultList = []
        for row in rows:
            if row[2] is None:
                continue
            score = 1 - float(row[2])
            if minimum is not None and score < minimum:
                continue
            hit: VectorSearchResult = {"id": str(row[0]), "score": score}
            if row[1] is not None:
                hit["metadata"] = cast(dict[str, Any], json.loads(row[1]))
            scored.append(hit)
        return finish_search(scored, opts)

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
