"""Optional sqlite-vec native computation on the store's existing connection."""

from __future__ import annotations

import importlib
import json
import math
import sqlite3
from typing import Any, Protocol, cast

from .vector import VectorSearchOptions, VectorSearchResult, VectorSearchResultList, vector_to_bytes


class SqliteVecError(RuntimeError):
    code = "native-vector-engine"


def _match(metadata: dict[str, Any], params: list[Any]) -> str:
    conditions = ["d.metadata IS NOT NULL"]
    for key, value in metadata.items():
        params.append(key)
        if isinstance(value, (dict, list)):
            params.extend(("array" if isinstance(value, list) else "object",
                           json.dumps(value, ensure_ascii=False, separators=(",", ":"))))
            conditions.append("EXISTS (SELECT 1 FROM json_each(d.metadata) f "
                              "WHERE f.key=? AND f.type=? AND f.value=?)")
        elif value is None:
            conditions.append("EXISTS (SELECT 1 FROM json_each(d.metadata) f "
                              "WHERE f.key=? AND f.type='null')")
        else:
            kinds = ("'true','false'" if isinstance(value, bool) else
                     "'integer','real'" if isinstance(value, (int, float)) else "'text'")
            params.append(value)
            conditions.append("EXISTS (SELECT 1 FROM json_each(d.metadata) f "
                              f"WHERE f.key=? AND f.type IN ({kinds}) AND f.value=?)")
    return "(" + " AND ".join(conditions) + ")"


class SqliteVectorEngine(Protocol):
    name: str

    def initialize(self, db: sqlite3.Connection) -> None: ...

    def search(
        self, db: sqlite3.Connection, namespace: str, collection: str, space: str,
        query: list[float], opts: VectorSearchOptions | None = None,
    ) -> VectorSearchResultList: ...


class SqliteVecEngine:
    name = "sqlite-vec"

    def initialize(self, db: sqlite3.Connection) -> None:
        try:
            extension = importlib.import_module("sqlite_vec")
            db.enable_load_extension(True)
            try:
                db.load_extension(extension.loadable_path())
            finally:
                db.enable_load_extension(False)
            row = db.execute("SELECT vec_version(),sqrt(4.0)").fetchone()
            if row is None or row[0] != "v0.1.6" or row[1] != 2.0:
                raise RuntimeError("Expected sqlite-vec v0.1.6 and SQLite math functions")
        except Exception as error:
            raise SqliteVecError("sqlite-vec initialization failed") from error

    def search(
        self, db: sqlite3.Connection, namespace: str, collection: str, space: str,
        query: list[float], opts: VectorSearchOptions | None = None,
    ) -> VectorSearchResultList:
        try:
            return self._search(db, namespace, collection, space, query, opts)
        except Exception as error:
            raise SqliteVecError("sqlite-vec search failed") from error

    def _search(
        self, db: sqlite3.Connection, namespace: str, collection: str, space: str,
        query: list[float], opts: VectorSearchOptions | None,
    ) -> VectorSearchResultList:
        options = opts or {}
        params: list[Any] = [namespace, collection, space]
        filters: list[str] = []
        if "where" in options:
            filters.append(_match(options["where"], params))
        if "whereNot" in options:
            filters.append("NOT " + _match(options["whereNot"], params))
        blob = vector_to_bytes(query)
        params.extend((blob, blob, blob, len(query)))
        minimum = options.get("minScore")
        floor = ""
        if minimum is not None and not math.isnan(minimum):
            floor = " AND score>=?"
            params.append(minimum)
        limit = options.get("topK", 10)
        limit_sql = (f"max((SELECT count(*) FROM accepted)+{limit},0)"
                     if limit < 0 else str(limit))
        epsilon = 16 * (len(query) + 1) * 2 ** -24
        coarse_limit = str(limit) if limit > 0 else "-1"
        sql = f"""WITH RECURSIVE
          population AS MATERIALIZED (
            SELECT v.id,v.vec,d.metadata FROM _mirk_vector_values v
            JOIN _mirk_vector_documents d USING(namespace,collection,id)
            WHERE v.namespace=? AND v.collection=? AND v.space=?
              {'AND ' + ' AND '.join(filters) if filters else ''}
          ), query_norm AS MATERIALIZED (
            SELECT vec_distance_l2(?,zeroblob({len(query) * 4})) norm
          ), coarse AS MATERIALIZED (
            SELECT p.*,1-vec_distance_cosine(p.vec,?) estimate,
              vec_distance_l2(p.vec,zeroblob(length(p.vec))) norm FROM population p
          ), bounds AS MATERIALIZED (
            SELECT c.*,
              CASE WHEN {len(query)}<=65536 AND c.norm BETWEEN 1e-8 AND 1e8
                AND q.norm BETWEEN 1e-8 AND 1e8 AND c.estimate BETWEEN -2 AND 2
                THEN c.estimate-{epsilon} ELSE -2 END lower_score,
              CASE WHEN {len(query)}<=65536 AND c.norm BETWEEN 1e-8 AND 1e8
                AND q.norm BETWEEN 1e-8 AND 1e8 AND c.estimate BETWEEN -2 AND 2
                THEN c.estimate+{epsilon} ELSE 2 END upper_score
            FROM coarse c CROSS JOIN query_norm q
          ), threshold AS (
            SELECT min(lower_score) value FROM
              (SELECT lower_score FROM bounds ORDER BY lower_score DESC LIMIT {coarse_limit})
          ), candidates AS MATERIALIZED (
            SELECT b.id,b.vec,b.metadata FROM bounds b,threshold t
            WHERE b.upper_score>=t.value
          ), query_components AS MATERIALIZED (
            SELECT rowid pos,value FROM vec_each(?)
          ), components AS MATERIALIZED (
            SELECT c.id,a.rowid pos,a.value av,b.value bv
            FROM candidates c,vec_each(c.vec) a JOIN query_components b ON b.pos=a.rowid
          ), scores(id,pos,dot,an,bn,valid) AS (
            SELECT id,0,0.0,0.0,0.0,1 FROM candidates
            UNION ALL
            SELECT s.id,s.pos+1,s.dot+c.av*c.bv,s.an+c.av*c.av,s.bn+c.bv*c.bv,
              s.valid AND c.av IS NOT NULL AND abs(c.av)<=3.4028234663852886e38
                AND c.bv IS NOT NULL AND abs(c.bv)<=3.4028234663852886e38
            FROM scores s JOIN components c ON c.id=s.id AND c.pos=s.pos
          ), ranked AS MATERIALIZED (
            SELECT id,CASE WHEN bn=0 THEN 0.0 ELSE dot/(sqrt(an)*sqrt(bn)) END score FROM scores
            WHERE pos=? AND valid AND an>0 AND bn>=0
          ), accepted AS MATERIALIZED (
            SELECT id,score FROM ranked WHERE score IS NOT NULL {floor}
          ) SELECT a.id,a.score,c.metadata FROM accepted a JOIN candidates c USING(id)
            ORDER BY a.score DESC,a.id COLLATE BINARY LIMIT {limit_sql}"""
        results: VectorSearchResultList = []
        for row in db.execute(sql, params):
            result: VectorSearchResult = {"id": str(row[0]), "score": float(row[1])}
            if row[2] is not None:
                result["metadata"] = cast(dict[str, Any], json.loads(row[2]))
            results.append(result)
        return results


def sqlite_vec_engine() -> SqliteVecEngine:
    return SqliteVecEngine()
