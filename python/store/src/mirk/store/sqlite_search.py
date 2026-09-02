"""SQLite search facet: FTS5 external-content tables over an open store connection.

Shares the connection the ``SqliteStore`` already opened, so the search tables
live in the same file as the KV and collection tables and a TypeScript reader
finds exactly what it expects: a ``_mirk_search_schema`` registry row, a
``search_docs_<name>_<hash>`` content table, a ``search_fts_<name>_<hash>``
external-content FTS5 index, and the three triggers that keep them in lockstep.

Document-side tokenization is FTS5's own ``unicode61``; only the query passes
through this package's tokenizer. The two agree on plain text and disagree on
diacritics, which ``unicode61`` folds away by default.
"""

from __future__ import annotations

import json
import math
import re
from typing import Any

from .filter import dumps_json, matches_where
from .search import (
    DEFAULT_SEARCH_FIELD,
    SearchDocument,
    SearchOptions,
    SearchResult,
    assert_same_search_fields,
    assert_valid_field_weight_values,
    field_weights_for,
    normalize_search_document,
    sanitize_fts_query,
)
from .sqlite import connection_of, hash_name

__all__ = ["SCHEMA_TABLE", "SqliteSearchFacet", "search_column_name"]

SCHEMA_TABLE = "_mirk_search_schema"
_UNSAFE_TABLE_CHARS = re.compile(r"[^a-zA-Z0-9_]")


def search_column_name(field: str, index: int) -> str:
    """The physical column for a field: ``text`` keeps its name, others are hashed.

    Hashing every other name is what lets a field be called ``title.with.dot`` or
    ``emoji 🔥`` without quoting problems inside the FTS5 declaration.
    """
    if field == DEFAULT_SEARCH_FIELD:
        return DEFAULT_SEARCH_FIELD
    return f"f{index}_{hash_name(field)}"


def _quote(identifier: str) -> str:
    escaped = identifier.replace('"', '""')
    return f'"{escaped}"'


def _sql_number(value: float) -> str:
    """Render a weight as a SQL literal the way ``String(weight)`` does."""
    if float(value).is_integer():
        return str(int(value))
    return repr(float(value))


class _Schema:
    __slots__ = ("columns", "fields")

    def __init__(self, fields: list[str]) -> None:
        self.fields = list(fields)
        self.columns = [search_column_name(field, index) for index, field in enumerate(fields)]


class SqliteSearchFacet:
    """bm25 search over FTS5, sharing one connection with the rest of the store."""

    def __init__(self, handle: object) -> None:
        self._db = connection_of(handle)
        self._ensured: set[str] = set()
        self._db.execute(
            f"CREATE TABLE IF NOT EXISTS {SCHEMA_TABLE} ("
            " collection TEXT PRIMARY KEY,"
            " fields_json TEXT NOT NULL)"
        )

    # ── Physical names ───────────────────────────────────────────────────
    def _base_table(self, collection: str) -> str:
        return f"search_docs_{_UNSAFE_TABLE_CHARS.sub('_', collection)}_{hash_name(collection)}"

    def _fts_table(self, collection: str) -> str:
        return f"search_fts_{_UNSAFE_TABLE_CHARS.sub('_', collection)}_{hash_name(collection)}"

    def _table_exists(self, table: str) -> bool:
        row = self._db.execute(
            "SELECT 1 FROM sqlite_master WHERE type IN ('table', 'view') AND name = ?",
            (table,),
        ).fetchone()
        return row is not None

    # ── Schema registry ──────────────────────────────────────────────────
    def _load_schema(self, collection: str) -> _Schema | None:
        row = self._db.execute(
            f"SELECT fields_json FROM {SCHEMA_TABLE} WHERE collection = ?", (collection,)
        ).fetchone()
        if row is not None:
            fields: list[str] = json.loads(row[0])
            return _Schema(fields)

        # A database written by the earlier single-column facet has the tables
        # but no registry row. Adopt it as the default {text} schema and record
        # that, rather than failing to read a file the TypeScript side can read.
        docs = self._base_table(collection)
        if not self._table_exists(docs):
            return None
        columns = [str(info[1]) for info in self._db.execute(f"PRAGMA table_info({_quote(docs)})")]
        if DEFAULT_SEARCH_FIELD not in columns:
            return None
        fields = [DEFAULT_SEARCH_FIELD]
        self._db.execute(
            f"INSERT OR IGNORE INTO {SCHEMA_TABLE}(collection, fields_json) VALUES (?, ?)",
            (collection, dumps_json(fields)),
        )
        return _Schema(fields)

    def _schema_for_index(self, collection: str, names: list[str]) -> _Schema:
        existing = self._load_schema(collection)
        if existing is not None:
            assert_same_search_fields(existing.fields, names, collection)
            return existing
        self._db.execute(
            f"INSERT INTO {SCHEMA_TABLE}(collection, fields_json) VALUES (?, ?)",
            (collection, dumps_json(names)),
        )
        return _Schema(names)

    # ── Physical tables ──────────────────────────────────────────────────
    def _ensure(self, collection: str, schema: _Schema) -> tuple[str, str]:
        docs = self._base_table(collection)
        fts = self._fts_table(collection)
        key = f"{docs}:{chr(0).join(schema.fields)}"
        if key in self._ensured:
            return (docs, fts)

        q_docs = _quote(docs)
        q_fts = _quote(fts)
        columns = ", ".join(_quote(column) for column in schema.columns)
        new_columns = ", ".join(f"new.{_quote(column)}" for column in schema.columns)
        old_columns = ", ".join(f"old.{_quote(column)}" for column in schema.columns)
        field_defs = ",\n        ".join(
            f"{_quote(column)} TEXT NOT NULL" for column in schema.columns
        )

        self._db.executescript(
            f"""
            CREATE TABLE IF NOT EXISTS {q_docs} (
              id TEXT PRIMARY KEY,
              {field_defs},
              meta_json TEXT
            );
            CREATE VIRTUAL TABLE IF NOT EXISTS {q_fts} USING fts5(
              {columns}, content='{docs}', content_rowid='rowid', tokenize='unicode61'
            );
            CREATE TRIGGER IF NOT EXISTS {_quote(docs + "_ai")} AFTER INSERT ON {q_docs} BEGIN
              INSERT INTO {q_fts}(rowid, {columns}) VALUES (new.rowid, {new_columns});
            END;
            CREATE TRIGGER IF NOT EXISTS {_quote(docs + "_ad")} AFTER DELETE ON {q_docs} BEGIN
              INSERT INTO {q_fts}({q_fts}, rowid, {columns})
                VALUES('delete', old.rowid, {old_columns});
            END;
            CREATE TRIGGER IF NOT EXISTS {_quote(docs + "_au")} AFTER UPDATE ON {q_docs} BEGIN
              INSERT INTO {q_fts}({q_fts}, rowid, {columns})
                VALUES('delete', old.rowid, {old_columns});
              INSERT INTO {q_fts}(rowid, {columns}) VALUES (new.rowid, {new_columns});
            END;
            """
        )
        self._ensured.add(key)
        return (docs, fts)

    # ── Port ─────────────────────────────────────────────────────────────
    def index(self, collection: str, doc: SearchDocument) -> None:
        names, values = normalize_search_document(doc)
        schema = self._schema_for_index(collection, names)
        docs, _ = self._ensure(collection, schema)
        columns = [_quote(column) for column in schema.columns]
        insert_columns = ", ".join([_quote("id"), *columns, _quote("meta_json")])
        placeholders = ", ".join("?" * (len(schema.columns) + 2))
        updates = ", ".join(
            [
                *(f"{column} = excluded.{column}" for column in columns),
                "meta_json = excluded.meta_json",
            ]
        )
        record: dict[str, Any] = dict(doc)
        meta_json = None if "meta" not in record else dumps_json(record["meta"])
        field_values = [_as_text(values.get(field)) for field in schema.fields]
        self._db.execute(
            f"INSERT INTO {_quote(docs)}({insert_columns}) VALUES ({placeholders})"
            f" ON CONFLICT(id) DO UPDATE SET {updates}",
            (str(record["id"]), *field_values, meta_json),
        )

    def indexMany(self, collection: str, docs: list[SearchDocument]) -> None:
        if not docs:
            return
        # Create the schema and the tables for the first document before opening
        # the transaction: SQLite cannot run the DDL script inside one, and a
        # later document with a different field list throws before any write.
        names, _ = normalize_search_document(docs[0])
        self._ensure(collection, self._schema_for_index(collection, names))
        self._db.execute("BEGIN IMMEDIATE")
        try:
            for doc in docs:
                self.index(collection, doc)
        except BaseException:
            self._db.execute("ROLLBACK")
            raise
        else:
            self._db.execute("COMMIT")

    def remove(self, collection: str, id: str) -> bool:
        schema = self._load_schema(collection)
        if schema is None:
            return False
        docs, _ = self._ensure(collection, schema)
        cursor = self._db.execute(f"DELETE FROM {_quote(docs)} WHERE id = ?", (id,))
        return cursor.rowcount > 0

    def search(
        self, collection: str, query: str, opts: SearchOptions | None = None
    ) -> list[SearchResult]:
        options: SearchOptions = opts or {}
        sanitized = sanitize_fts_query(query)
        assert_valid_field_weight_values(options.get("fieldWeights"))
        if not sanitized:
            return []
        schema = self._load_schema(collection)
        if schema is None:
            return []
        docs, fts = self._ensure(collection, schema)
        weights = field_weights_for(schema.fields, options.get("fieldWeights"))
        weight_args = "".join(f", {_sql_number(weight)}" for weight in weights)
        rows = self._db.execute(
            f"SELECT d.id AS id, d.meta_json AS meta_json,"
            f" bm25({_quote(fts)}{weight_args}) AS bm"
            f" FROM {_quote(fts)}"
            f" JOIN {_quote(docs)} d ON d.rowid = {_quote(fts)}.rowid"
            f" WHERE {_quote(fts)} MATCH ?"
            f" ORDER BY bm, d.id",
            (sanitized,),
        ).fetchall()

        limit = options.get("limit", 10)
        where = (options.get("filter") or {}).get("where")
        # The meta filter runs after the SQL ordering and before the limit, so a
        # filtered search returns up to `limit` surviving rows rather than the
        # survivors of the first `limit` rows.
        out: list[SearchResult] = []
        for row in rows:
            meta: dict[str, Any] = {} if row[1] is None else json.loads(row[1])
            if where and not matches_where(meta, where):
                continue
            out.append({"id": str(row[0]), "score": -float(row[2]), "meta": meta})
        return out[: math.trunc(limit)]


def _as_text(value: Any) -> str:
    """A missing or null field value indexes as the empty string, as it does in TypeScript."""
    return value if isinstance(value, str) else ""
