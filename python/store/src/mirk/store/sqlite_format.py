"""Version three named-vector migration, inside the registry writer lock."""

from __future__ import annotations

import sqlite3

VECTOR_DDL = """
CREATE TABLE IF NOT EXISTS _mirk_vector_spaces (
 namespace TEXT NOT NULL, name TEXT NOT NULL, dimensions INTEGER NOT NULL CHECK(dimensions>0),
 metric TEXT NOT NULL CHECK(metric='cosine'),
 encoding TEXT NOT NULL CHECK(encoding='float32'),
 PRIMARY KEY(namespace,name));
CREATE TABLE IF NOT EXISTS _mirk_vector_documents (
 namespace TEXT NOT NULL, collection TEXT NOT NULL,
 id TEXT NOT NULL, metadata TEXT,
 PRIMARY KEY(namespace,collection,id));
CREATE TABLE IF NOT EXISTS _mirk_vector_values (
 namespace TEXT NOT NULL, collection TEXT NOT NULL,
 id TEXT NOT NULL,
 space TEXT NOT NULL, vec BLOB NOT NULL,

 PRIMARY KEY(namespace,collection,id,space),
 FOREIGN KEY(namespace,collection,id) REFERENCES _mirk_vector_documents(namespace,collection,id)
 ON DELETE CASCADE,
 FOREIGN KEY(namespace,space) REFERENCES _mirk_vector_spaces(namespace,name));"""


def migrate_vectors(connection: sqlite3.Connection, legacy_vector_space: str = "default") -> None:
    def exists(name: str) -> bool:
        return (
            connection.execute(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (name,)
            ).fetchone()
            is not None
        )

    dimensions: int | None = None
    if exists("_vec_meta"):
        row = connection.execute("SELECT value FROM _vec_meta WHERE key='dimensions'").fetchone()
        if row is not None:
            try:
                dimensions = int(row[0])
            except (TypeError, ValueError) as error:
                raise ValueError("Invalid legacy vector dimensions") from error
            if dimensions <= 0 or dimensions > 2**53 - 1 or str(dimensions) != str(row[0]):
                raise ValueError("Invalid legacy vector dimensions")
    if exists("vectors"):
        columns = {row[1] for row in connection.execute("PRAGMA table_info(vectors)")}
        if not {"collection", "id", "vec", "metadata"}.issubset(columns):
            raise ValueError("Unrecognized legacy vectors layout")
        lengths = connection.execute(
            "SELECT DISTINCT length(vec),typeof(vec) FROM vectors"
        ).fetchall()
        if any(kind != "blob" or length <= 0 or length % 4 for length, kind in lengths):
            raise ValueError("Invalid legacy vector BLOB")
        if dimensions is None and lengths:
            dimensions = lengths[0][0] // 4
        if lengths and (
            dimensions is None or any(length != dimensions * 4 for length, _ in lengths)
        ):
            raise ValueError("Legacy vector dimensions do not match BLOB lengths")
    for statement in VECTOR_DDL.split(";"):
        if statement.strip():
            connection.execute(statement)
    if dimensions is not None:
        connection.execute(
            "INSERT INTO _mirk_vector_spaces VALUES('default',?,?,'cosine','float32')",
            (legacy_vector_space, dimensions),
        )
    if exists("vectors"):
        connection.execute(
            "INSERT INTO _mirk_vector_documents SELECT "
            "'default',collection,id,metadata FROM vectors"
        )
        connection.execute(
            "INSERT INTO _mirk_vector_values SELECT 'default',collection,id,?,vec FROM vectors",
            (legacy_vector_space,),
        )
        connection.execute("DROP TABLE vectors")
    if exists("_vec_meta"):
        connection.execute("DROP TABLE _vec_meta")
