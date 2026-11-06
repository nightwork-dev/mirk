"""Optional sqlite-vec native computation on the store's existing connection."""

from __future__ import annotations

import importlib
import json
import math
import sqlite3
from typing import Any, Protocol, cast

from .filter import dumps_json
from .vector import (
    VectorSearchOptions,
    VectorSearchResult,
    VectorSearchResultList,
    top_k_of,
    vector_to_bytes,
)


class SqliteVecError(RuntimeError):
    code = "native-vector-engine"


def _match(metadata: dict[str, Any], params: list[Any]) -> str:
    conditions = ["d.metadata IS NOT NULL"]
    for key, value in metadata.items():
        params.append(key)
        if isinstance(value, (dict, list)):
            params.extend(("array" if isinstance(value, list) else "object", dumps_json(value)))
            conditions.append(
                "EXISTS (SELECT 1 FROM json_each(d.metadata) f "
                "WHERE f.key=? AND f.type=? AND f.value=?)"
            )
        elif value is None:
            conditions.append(
                "EXISTS (SELECT 1 FROM json_each(d.metadata) f WHERE f.key=? AND f.type='null')"
            )
        else:
            kinds = (
                "'true','false'"
                if isinstance(value, bool)
                else "'integer','real'"
                if isinstance(value, (int, float))
                else "'text'"
            )
            params.append(value)
            conditions.append(
                "EXISTS (SELECT 1 FROM json_each(d.metadata) f "
                f"WHERE f.key=? AND f.type IN ({kinds}) AND f.value=?)"
            )
    return "(" + " AND ".join(conditions) + ")"


class SqliteVectorEngine(Protocol):
    name: str

    def initialize(self, db: sqlite3.Connection) -> bool | None: ...

    def search(
        self,
        db: sqlite3.Connection,
        namespace: str,
        collection: str,
        space: str,
        query: list[float],
        opts: VectorSearchOptions | None = None,
    ) -> VectorSearchResultList: ...


class SqliteVecEngine:
    name = "sqlite-vec"

    def initialize(self, db: sqlite3.Connection) -> bool | None:
        try:
            try:
                extension = importlib.import_module("mirk_sqlite_vec_native")
            except ModuleNotFoundError as error:
                if error.name == "mirk_sqlite_vec_native":
                    return False
                raise
            try:
                path = extension.loadable_path()
            except Exception as error:
                if getattr(error, "code", None) == "native-companion-unavailable":
                    return False
                raise
            db.enable_load_extension(True)
            try:
                db.load_extension(path)
            finally:
                db.enable_load_extension(False)
            row = db.execute(
                "SELECT vec_version(),vec_cosine_similarity_f64(vec_f32('[1,0]'),vec_f32('[1,0]'))"
            ).fetchone()
            if row is None or row[0] != "v0.1.6" or row[1] != 1.0:
                raise RuntimeError("Expected Mirk sqlite-vec v0.1.6 with float64 cosine")
        except Exception as error:
            raise SqliteVecError("sqlite-vec initialization failed") from error

    def search(
        self,
        db: sqlite3.Connection,
        namespace: str,
        collection: str,
        space: str,
        query: list[float],
        opts: VectorSearchOptions | None = None,
    ) -> VectorSearchResultList:
        try:
            return self._search(db, namespace, collection, space, query, opts)
        except Exception as error:
            raise SqliteVecError("sqlite-vec search failed") from error

    def _search(
        self,
        db: sqlite3.Connection,
        namespace: str,
        collection: str,
        space: str,
        query: list[float],
        opts: VectorSearchOptions | None,
    ) -> VectorSearchResultList:
        options = opts or {}
        params: list[Any] = [namespace, collection, space]
        filters: list[str] = []
        if "where" in options:
            filters.append(_match(options["where"], params))
        if "whereNot" in options:
            filters.append("NOT " + _match(options["whereNot"], params))
        blob = vector_to_bytes(query)
        params.append(blob)
        minimum = options.get("minScore")
        floor = ""
        if minimum is not None and not math.isnan(minimum):
            floor = " AND score>=?"
            params.append(minimum)
        limit = top_k_of(opts)
        limit_sql = f"max((SELECT count(*) FROM accepted)+{limit},0)" if limit < 0 else str(limit)
        sql = f"""WITH population AS NOT MATERIALIZED (
            SELECT v.id,v.vec,d.metadata FROM _mirk_vector_values v
            JOIN _mirk_vector_documents d USING(namespace,collection,id)
            WHERE v.namespace=? AND v.collection=? AND v.space=?
              {"AND " + " AND ".join(filters) if filters else ""}
          ), ranked AS MATERIALIZED (
            SELECT id,metadata,vec_cosine_similarity_f64(vec,?) score FROM population
          ), accepted AS MATERIALIZED (
            SELECT id,metadata,score FROM ranked WHERE score IS NOT NULL {floor}
          ) SELECT id,score,metadata FROM accepted
            ORDER BY score DESC,id COLLATE BINARY LIMIT {limit_sql}"""
        results: VectorSearchResultList = []
        for row in db.execute(sql, params):
            result: VectorSearchResult = {"id": str(row[0]), "score": float(row[1])}
            if row[2] is not None:
                result["metadata"] = cast(dict[str, Any], json.loads(row[2]))
            results.append(result)
        return results


def sqlite_vec_engine() -> SqliteVecEngine:
    return SqliteVecEngine()
