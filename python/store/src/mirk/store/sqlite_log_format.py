"""Canonical format-4 log layout and migration from sequence-only streams."""

from __future__ import annotations

import sqlite3

LOG_FORMAT_DDL = (
    "CREATE TABLE IF NOT EXISTS _mirk_log ("
    "stream TEXT NOT NULL, sequence INTEGER NOT NULL CHECK (sequence >= 1),"
    "record TEXT NOT NULL, PRIMARY KEY (stream, sequence)) WITHOUT ROWID",
    "CREATE TABLE IF NOT EXISTS _mirk_log_generation ("
    "id INTEGER PRIMARY KEY CHECK (id = 1),"
    "value INTEGER NOT NULL CHECK (value >= 0 AND value <= 9007199254740991))",
    "INSERT INTO _mirk_log_generation (id, value) VALUES (1, 0) ON CONFLICT(id) DO NOTHING",
    "CREATE TABLE IF NOT EXISTS _mirk_log_streams ("
    "stream TEXT PRIMARY KEY, generation INTEGER NOT NULL UNIQUE "
    "CHECK (generation >= 1 AND generation <= 9007199254740991)) WITHOUT ROWID",
)


def migrate_log_generations(db: sqlite3.Connection) -> None:
    for statement in LOG_FORMAT_DDL:
        db.execute(statement)
    db.execute(
        "INSERT INTO _mirk_log_streams (stream, generation) "
        "SELECT stream, ROW_NUMBER() OVER (ORDER BY stream COLLATE BINARY) "
        "FROM (SELECT DISTINCT stream FROM _mirk_log)"
    )
    db.execute(
        "UPDATE _mirk_log_generation SET value = "
        "(SELECT COALESCE(MAX(generation), 0) FROM _mirk_log_streams) WHERE id = 1"
    )
