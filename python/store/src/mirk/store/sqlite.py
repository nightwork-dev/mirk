"""SQLite source adapter over the stdlib ``sqlite3`` module.

Opens files the TypeScript ``@mirk/store/sqlite`` adapter wrote and writes files
it can read: identical table names, DDL, pragmas and JSON encoding, and the same
atomic bookkeeping rows on every write so the TypeScript versioned-read surface
stays correct for rows Python created.
"""

from __future__ import annotations

import json
import re
import sqlite3
import uuid
from collections.abc import Generator
from contextlib import contextmanager
from types import TracebackType
from typing import Any

from .atomic import (
    IN_PROCESS_ATOMIC_LIMITS,
    AtomicMutationBackendError,
    AtomicMutationLimits,
    ValidatedRequest,
    clone_condition,
    clone_json,
    condition_matches,
    operation_target,
    resolve_atomic_limits,
    validate_atomic_request,
)
from .filter import FILTER_SCALAR_MESSAGE, IN_SCALAR_MESSAGE, dumps_json, is_scalar
from .types import JsonObject, StoreFilter, StoreMeta

__all__ = [
    "META_TABLE",
    "REGISTRY_TABLE",
    "SCHEMA_VERSION",
    "TABLE_RESOLUTION_ATTEMPTS",
    "SqliteStore",
    "build_limit_offset",
    "build_order_by",
    "build_where_clause",
    "ensure_registry",
    "hash_name",
    "is_table_registry_conflict",
    "json_path",
    "legacy_collection_table",
    "lookup_table",
    "resolve_table",
    "table_exists",
]

_BASE36 = "0123456789abcdefghijklmnopqrstuvwxyz"
_UNSAFE_TABLE_CHARS = re.compile(r"[^a-zA-Z0-9_]")
_LIKE_SPECIALS = re.compile(r"([\\%_])")
_SAFE_TABLE_NAME = re.compile(r"^[A-Za-z0-9_]+$")

REGISTRY_TABLE = "_mirk_tables"
META_TABLE = "_mirk_meta"
SCHEMA_VERSION = 2

SqlParam = str | int | float | None


def _base36(value: int) -> str:
    if value == 0:
        return "0"
    digits: list[str] = []
    while value:
        value, remainder = divmod(value, 36)
        digits.append(_BASE36[remainder])
    return "".join(reversed(digits))


def hash_name(name: str) -> str:
    """32-bit FNV-1a over UTF-16 code units, rendered base36.

    Iterating code units rather than code points is load-bearing: an astral-plane
    collection name hashes differently under the two schemes.
    """
    encoded = name.encode("utf-16-le")
    h = 2166136261
    for index in range(0, len(encoded), 2):
        unit = encoded[index] | (encoded[index + 1] << 8)
        h ^= unit
        h = (h * 16777619) & 0xFFFFFFFF
    return _base36(h)


def json_path(field: str) -> str:
    """A field name is ONE top-level JSON key, never a nested path."""
    escaped = field.replace('"', '""')
    return f'$."{escaped}"'


def _type_guard(value: Any) -> str:
    if isinstance(value, bool):
        return "json_type(data, ?) IN ('true', 'false')"
    if isinstance(value, int | float):
        return "json_type(data, ?) IN ('integer', 'real')"
    return "json_type(data, ?) = 'text'"


def _bind(value: Any) -> SqlParam:
    if isinstance(value, bool):
        return 1 if value else 0
    if isinstance(value, int | float | str):
        return value
    raise ValueError(FILTER_SCALAR_MESSAGE)


def build_where_clause(filter: StoreFilter | None = None) -> tuple[str, list[SqlParam]]:
    """Exact-match conditions, ANDed. Booleans and numbers stay distinct."""
    where = filter.get("where") if filter else None
    if not where:
        return ("", [])
    conditions: list[str] = []
    params: list[SqlParam] = []
    for key, value in where.items():
        path = json_path(key)
        if value is None:
            conditions.append("json_type(data, ?) = 'null'")
            params.append(path)
            continue
        if not is_scalar(value):
            raise ValueError(FILTER_SCALAR_MESSAGE)
        conditions.append(f"(json_extract(data, ?) = ? AND {_type_guard(value)})")
        params.extend([path, _bind(value), path])
    return (f" WHERE {' AND '.join(conditions)}", params)


def build_order_by(filter: StoreFilter | None = None) -> tuple[str, list[SqlParam]]:
    """Null and missing values last in both directions; rowid breaks ties."""
    sort_by = filter.get("sortBy") if filter else None
    if not sort_by:
        return (" ORDER BY rowid", [])
    direction = "DESC" if (filter or {}).get("sortDir") == "desc" else "ASC"
    path = json_path(sort_by)
    clause = f" ORDER BY json_extract(data, ?) IS NULL, json_extract(data, ?) {direction}, rowid"
    return (clause, [path, path])


def build_limit_offset(filter: StoreFilter | None = None) -> str:
    """LIMIT clamps to zero; a fractional bound floors."""
    if not filter:
        return ""
    sql = ""
    limit = filter.get("limit")
    if limit is not None:
        sql += f" LIMIT {max(0, int(limit // 1))}"
    offset = filter.get("offset")
    if offset is not None and offset > 0:
        if "LIMIT" not in sql:
            sql += " LIMIT -1"
        sql += f" OFFSET {max(0, int(offset // 1))}"
    return sql


def _build_in_clause(
    field: str, values: list[Any], has_prior_where: bool
) -> tuple[str, list[SqlParam]]:
    path = json_path(field)
    parts: list[str] = []
    params: list[SqlParam] = []
    for value in values:
        if value is None:
            parts.append("json_type(data, ?) = 'null'")
            params.append(path)
            continue
        if not is_scalar(value):
            raise ValueError(IN_SCALAR_MESSAGE)
        parts.append(f"(json_extract(data, ?) = ? AND {_type_guard(value)})")
        params.extend([path, _bind(value), path])
    keyword = " AND" if has_prior_where else " WHERE"
    return (f"{keyword} ({' OR '.join(parts)})", params)


_REGISTRY_DDL = (
    f"""CREATE TABLE IF NOT EXISTS {META_TABLE} (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )""",
    f"""CREATE TABLE IF NOT EXISTS {REGISTRY_TABLE} (
      kind TEXT NOT NULL,
      name TEXT NOT NULL,
      table_name TEXT NOT NULL UNIQUE,
      PRIMARY KEY (kind, name)
    )""",
)


@contextmanager
def _registry_write(connection: sqlite3.Connection) -> Generator[sqlite3.Connection]:
    """A write transaction, unless the caller already opened one."""
    if connection.in_transaction:
        yield connection
        return
    connection.execute("BEGIN IMMEDIATE")
    try:
        yield connection
    except BaseException:
        connection.execute("ROLLBACK")
        raise
    else:
        connection.execute("COMMIT")


def table_exists(connection: sqlite3.Connection, table: str) -> bool:
    row = connection.execute(
        "SELECT 1 FROM sqlite_master WHERE type IN ('table', 'view') AND name = ?",
        (table,),
    ).fetchone()
    return row is not None


def _stored_schema_version(connection: sqlite3.Connection) -> str | None:
    row = connection.execute(
        f"SELECT value FROM {META_TABLE} WHERE key = 'schema_version'"
    ).fetchone()
    return None if row is None else str(row[0])


def ensure_registry(connection: sqlite3.Connection) -> None:
    """Create the table registry and stamp the schema version, or refuse the file.

    A file written by a newer adapter may map logical names to physical tables by
    rules this code does not know, so reading it by the rules below would return
    the wrong rows rather than fail. Refuse instead.
    """
    with _registry_write(connection):
        connection.execute(_REGISTRY_DDL[0])
        found = _stored_schema_version(connection)
        if found is not None:
            parsed = _parse_version(found)
            if parsed is not None and parsed > SCHEMA_VERSION:
                raise ValueError(
                    f"Mirk SQLite file schema version {found} is newer than this"
                    f" adapter understands ({SCHEMA_VERSION})."
                )
        connection.execute(_REGISTRY_DDL[1])
        if found is None:
            connection.execute(
                f"INSERT OR IGNORE INTO {META_TABLE} (key, value) VALUES ('schema_version', ?)",
                (str(SCHEMA_VERSION),),
            )


_LEADING_INT = re.compile(r"^\s*[+-]?[0-9]+")


def _parse_version(value: str) -> int | None:
    """Leading-integer parse, matching JavaScript ``Number.parseInt(value, 10)``.

    A value that parses to nothing belongs to whichever adapter wrote it and is
    not turned into a refusal to open.
    """
    match = _LEADING_INT.match(value)
    return None if match is None else int(match.group(0))


def lookup_table(connection: sqlite3.Connection, kind: str, name: str) -> str | None:
    """The physical table recorded for a logical name, without claiming one."""
    row = connection.execute(
        f"SELECT table_name FROM {REGISTRY_TABLE} WHERE kind = ? AND name = ?",
        (kind, name),
    ).fetchone()
    if row is None:
        return None
    return _checked_table_name(str(row[0]))


def _checked_table_name(table: str) -> str:
    if not _SAFE_TABLE_NAME.match(table):
        raise ValueError(f"Mirk table registry holds an unusable physical table name {table!r}.")
    return table


def claimed_by_other(connection: sqlite3.Connection, table: str, kind: str, name: str) -> bool:
    row = connection.execute(
        f"SELECT kind, name FROM {REGISTRY_TABLE} WHERE table_name = ?", (table,)
    ).fetchone()
    return row is not None and (str(row[0]), str(row[1])) != (kind, name)


def _unavailable(connection: sqlite3.Connection, table: str, kind: str, name: str) -> bool:
    """A suffixed candidate is off limits if anything already holds that name.

    Two ways it can be held: a registry row for a different logical name, or a
    physical table nothing in the registry accounts for. The second is what makes
    ``CREATE TABLE IF NOT EXISTS`` on a suffixed candidate safe, because a table
    already sitting under that name would otherwise be silently reused. Adoption
    of an unaccounted-for table is reserved for the exact legacy name.
    """
    if claimed_by_other(connection, table, kind, name):
        return True
    registered = connection.execute(
        f"SELECT 1 FROM {REGISTRY_TABLE} WHERE table_name = ?", (table,)
    ).fetchone()
    return registered is None and table_exists(connection, table)


TABLE_RESOLUTION_ATTEMPTS = 5


def is_table_registry_conflict(error: BaseException) -> bool:
    """True for the constraint error two processes can produce when both resolve the
    same new logical name at once: one INSERT into ``_mirk_tables`` wins, the other
    violates its primary key or its UNIQUE ``table_name``. The loser must RESTART
    resolution — the winner's row is now a registry hit — rather than surface a
    constraint error from an ordinary ``put``.
    """
    message = str(error)
    return "constraint failed" in message and REGISTRY_TABLE in message


def resolve_table(connection: sqlite3.Connection, kind: str, name: str, legacy_name: str) -> str:
    """The physical table for a logical name, claiming one if it has none yet.

    Registry hit wins. Otherwise an unclaimed legacy table by the pre-registry
    hashed name is adopted, so files written before the registry keep reading.
    Otherwise the legacy name is claimed, with ``_2``, ``_3``... appended past
    every candidate another name holds or an unregistered table already occupies.
    Hash collisions therefore separate instead of aliasing. The caller creates the
    table.

    Two connections can resolve the same new logical name at once; one wins the
    INSERT into ``_mirk_tables`` and the other loses to a constraint violation.
    Resolution restarts from step 1 on a losing violation, up to five attempts —
    by then the winner's row is a registry hit, so the loser adopts its table.
    """
    for attempt in range(1, TABLE_RESOLUTION_ATTEMPTS + 1):
        try:
            return _resolve_table_once(connection, kind, name, legacy_name)
        except sqlite3.IntegrityError as error:
            if attempt >= TABLE_RESOLUTION_ATTEMPTS or not is_table_registry_conflict(error):
                raise
    raise AssertionError("unreachable")


def _resolve_table_once(
    connection: sqlite3.Connection, kind: str, name: str, legacy_name: str
) -> str:
    """One resolution pass: a registry lookup, then zero or more claim checks, then
    (on a miss) one INSERT. Deliberately NOT wrapped in its own transaction — same
    as the TypeScript ``resolveTableOnce`` this mirrors — so each step runs as its
    own autocommit statement (or joins a transaction a caller already holds on this
    connection) rather than holding a write lock for the whole pass. A lock held
    for the whole pass would itself serialize two connections racing to register
    the same new name, but at the cost of one blocking the other until it commits
    or times out; the retry in ``resolve_table`` is the cheaper alternative,
    catching the resulting constraint violation and re-reading the registry
    instead of holding a lock a busy caller does not need.
    """
    hit = lookup_table(connection, kind, name)
    if hit is not None:
        return hit
    legacy = _checked_table_name(legacy_name)
    adoptable = table_exists(connection, legacy) and not claimed_by_other(
        connection, legacy, kind, name
    )
    if adoptable:
        _record_table(connection, kind, name, legacy)
        return legacy
    candidate = legacy
    suffix = 2
    while _unavailable(connection, candidate, kind, name):
        candidate = f"{legacy}_{suffix}"
        suffix += 1
    _record_table(connection, kind, name, candidate)
    return candidate


def _record_table(connection: sqlite3.Connection, kind: str, name: str, table: str) -> None:
    connection.execute(
        f"INSERT INTO {REGISTRY_TABLE} (kind, name, table_name) VALUES (?, ?, ?)",
        (kind, name, table),
    )


def legacy_collection_table(collection: str) -> str:
    """The pre-registry physical name for a collection: sanitized, then hashed."""
    if len(collection) == 0:
        raise ValueError("Invalid collection name")
    sanitized = _UNSAFE_TABLE_CHARS.sub("_", collection)
    return f"c_{sanitized}_{hash_name(collection)}"


_BOOTSTRAP_DDL = (
    """CREATE TABLE IF NOT EXISTS _kv (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )""",
    """CREATE TABLE IF NOT EXISTS _mirk_atomic_versions (
      kind TEXT NOT NULL,
      collection TEXT NOT NULL,
      target_key TEXT NOT NULL,
      version TEXT NOT NULL,
      PRIMARY KEY (kind, collection, target_key)
    )""",
    """CREATE TABLE IF NOT EXISTS _mirk_atomic_sequence (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      value INTEGER NOT NULL
    )""",
    """CREATE TABLE IF NOT EXISTS _mirk_atomic_receipts (
      idempotency_key TEXT PRIMARY KEY,
      request_digest TEXT NOT NULL,
      result_json TEXT NOT NULL
    )""",
    """CREATE TABLE IF NOT EXISTS _mirk_atomic_identity (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      value TEXT NOT NULL
    )""",
)


class SqliteStore:
    """KV plus collection store on one SQLite connection.

    Threading: one connection per thread. The connection is thread-affine, the
    way ``sqlite3`` opens it by default and the way the TypeScript adapter's
    single-threaded model works. Using a store from a second thread raises
    ``sqlite3.ProgrammingError`` rather than corrupting an interleaved
    transaction. Build a second store for a second thread.

    Transactions: the store owns transaction semantics on whatever connection it
    is given. A supplied connection is switched to ``isolation_level = None``
    (SQLite autocommit, with explicit ``BEGIN IMMEDIATE`` around every write),
    which commits any transaction the caller left pending.
    """

    def __init__(
        self,
        path: str,
        *,
        busy_timeout_ms: int = 30_000,
        connection: sqlite3.Connection | None = None,
        version_identity: str | None = None,
        atomic_limits: AtomicMutationLimits | dict[str, Any] | None = None,
    ) -> None:
        if busy_timeout_ms < 0:
            raise ValueError(f"busy_timeout_ms must be non-negative; got {busy_timeout_ms}.")
        self._meta = StoreMeta(backend="sqlite")
        self._atomic_limits = resolve_atomic_limits(atomic_limits, IN_PROCESS_ATOMIC_LIMITS)
        self._owns_connection = connection is None
        self._db = connection or sqlite3.connect(path, isolation_level=None)
        # The store owns transaction semantics: explicit BEGIN IMMEDIATE around
        # every write, so the connection must be in SQLite autocommit mode. On a
        # supplied connection this commits whatever the caller left pending.
        self._db.isolation_level = None
        self._tables: dict[str, str] = {}
        # Pragmas run outside any transaction; journal_mode is a no-op inside one.
        self._db.execute(f"PRAGMA busy_timeout = {busy_timeout_ms}")
        self._db.execute("PRAGMA journal_mode = WAL")
        self._db.execute("PRAGMA foreign_keys = ON")
        try:
            ensure_registry(self._db)
        except BaseException:
            if self._owns_connection:
                self._db.close()
            raise
        with self._write():
            for statement in _BOOTSTRAP_DDL:
                self._db.execute(statement)
            self._db.execute(
                "INSERT OR IGNORE INTO _mirk_atomic_sequence (id, value) VALUES (1, 0)"
            )
            # A file's persisted identity wins: the injected value only names an
            # identity this process would otherwise have generated.
            self._db.execute(
                "INSERT OR IGNORE INTO _mirk_atomic_identity (id, value) VALUES (1, ?)",
                (version_identity if version_identity is not None else str(uuid.uuid4()),),
            )
            row = self._db.execute(
                "SELECT value FROM _mirk_atomic_identity WHERE id = 1"
            ).fetchone()
        self._version_prefix: str = row[0]

    @property
    def meta(self) -> StoreMeta:
        return self._meta

    @property
    def atomic_limits(self) -> AtomicMutationLimits:
        """The request bounds this store enforces."""
        return self._atomic_limits

    @property
    def connection(self) -> sqlite3.Connection:
        """The live connection, shared by the vector and search facets."""
        return self._db

    @property
    def busy_timeout_ms(self) -> int:
        """The connection's configured SQLITE_BUSY wait, in milliseconds."""
        row = self._db.execute("PRAGMA busy_timeout").fetchone()
        return int(row[0])

    def close(self) -> None:
        if self._owns_connection:
            self._db.close()

    def __enter__(self) -> SqliteStore:
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        tb: TracebackType | None,
    ) -> None:
        self.close()

    @contextmanager
    def _write(self) -> Generator[sqlite3.Connection]:
        self._db.execute("BEGIN IMMEDIATE")
        try:
            yield self._db
        except BaseException:
            self._db.execute("ROLLBACK")
            raise
        else:
            self._db.execute("COMMIT")

    @contextmanager
    def _write_scope(self) -> Generator[sqlite3.Connection]:
        """A write transaction, unless this connection is already inside one."""
        if self._db.in_transaction:
            yield self._db
            return
        with self._write() as connection:
            yield connection

    # ── Table naming ─────────────────────────────────────────────────────
    def _ensure_table(self, collection: str) -> str:
        """Resolve the collection's physical table through the registry, then create it.

        Called from read paths too: resolution happens on first use of a logical
        name, and the cache holds the resolved name for the life of the store.
        """
        cached = self._tables.get(collection)
        if cached is not None:
            return cached
        table = resolve_table(
            self._db, "collection", collection, legacy_collection_table(collection)
        )
        self._db.execute(
            f"""CREATE TABLE IF NOT EXISTS {table} (
              id TEXT PRIMARY KEY,
              data JSON NOT NULL,
              created_at TEXT DEFAULT (datetime('now')),
              updated_at TEXT DEFAULT (datetime('now'))
            )"""
        )
        # A caller may have opened a transaction on the shared connection; an
        # outer rollback would undo both the registry row and the table, so the
        # cache only takes a resolution that is already committed.
        if not self._db.in_transaction:
            self._tables[collection] = table
        return table

    # ── Atomic bookkeeping ───────────────────────────────────────────────
    def _write_version(self, kind: str, collection: str, target_key: str) -> str:
        self._db.execute("UPDATE _mirk_atomic_sequence SET value = value + 1 WHERE id = 1")
        row = self._db.execute("SELECT value FROM _mirk_atomic_sequence WHERE id = 1").fetchone()
        version = f"{self._version_prefix}-v{row[0]}"
        self._db.execute(
            "INSERT INTO _mirk_atomic_versions"
            " (kind, collection, target_key, version) VALUES (?, ?, ?, ?)"
            " ON CONFLICT(kind, collection, target_key)"
            " DO UPDATE SET version = excluded.version",
            (kind, collection, target_key, version),
        )
        return version

    def _clear_version(self, kind: str, collection: str, target_key: str) -> None:
        self._db.execute(
            "DELETE FROM _mirk_atomic_versions"
            " WHERE kind = ? AND collection = ? AND target_key = ?",
            (kind, collection, target_key),
        )

    # ── Key-value ────────────────────────────────────────────────────────
    def get(self, key: str) -> Any:
        row = self._db.execute("SELECT value FROM _kv WHERE key = ?", (key,)).fetchone()
        if row is None:
            return None
        return json.loads(row[0])

    def set(self, key: str, value: Any) -> None:
        encoded = dumps_json(value)
        with self._write():
            self._db.execute(
                """INSERT INTO _kv (key, value, updated_at) VALUES (?, ?, datetime('now'))
                   ON CONFLICT(key) DO UPDATE SET value = excluded.value,
                                                 updated_at = datetime('now')""",
                (key, encoded),
            )
            self._write_version("key", "", key)

    def has(self, key: str) -> bool:
        return self._db.execute("SELECT 1 FROM _kv WHERE key = ?", (key,)).fetchone() is not None

    def delete(self, key: str) -> bool:
        with self._write():
            cursor = self._db.execute("DELETE FROM _kv WHERE key = ?", (key,))
            deleted = cursor.rowcount > 0
            if deleted:
                self._clear_version("key", "", key)
        return deleted

    def keys(self, prefix: str | None = None) -> list[str]:
        if prefix:
            escaped = _LIKE_SPECIALS.sub(r"\\\1", prefix)
            rows = self._db.execute(
                "SELECT key FROM _kv WHERE key LIKE ? ESCAPE '\\' ORDER BY key",
                (f"{escaped}%",),
            ).fetchall()
        else:
            rows = self._db.execute("SELECT key FROM _kv ORDER BY key").fetchall()
        return [row[0] for row in rows]

    # ── Collections ──────────────────────────────────────────────────────
    def list(self, collection: str, filter: StoreFilter | None = None) -> list[Any]:
        table = self._ensure_table(collection)
        where_clause, where_params = build_where_clause(filter)
        order_clause, order_params = build_order_by(filter)
        sql = f"SELECT data FROM {table}{where_clause}{order_clause}{build_limit_offset(filter)}"
        rows = self._db.execute(sql, (*where_params, *order_params)).fetchall()
        return [json.loads(row[0]) for row in rows]

    def listWhereIn(
        self,
        collection: str,
        field: str,
        values: list[Any],
        filter: StoreFilter | None = None,
    ) -> list[Any]:
        if len(values) == 0:
            return []
        table = self._ensure_table(collection)
        where_clause, where_params = build_where_clause(filter)
        in_clause, in_params = _build_in_clause(field, values, len(where_clause) > 0)
        order_clause, order_params = build_order_by(filter)
        sql = (
            f"SELECT data FROM {table}{where_clause}{in_clause}"
            f"{order_clause}{build_limit_offset(filter)}"
        )
        rows = self._db.execute(sql, (*where_params, *in_params, *order_params)).fetchall()
        return [json.loads(row[0]) for row in rows]

    def getById(self, collection: str, id: str) -> Any:
        table = self._ensure_table(collection)
        row = self._db.execute(f"SELECT data FROM {table} WHERE id = ?", (id,)).fetchone()
        if row is None:
            return None
        return json.loads(row[0])

    def put(self, collection: str, item: JsonObject) -> JsonObject:
        table = self._ensure_table(collection)
        item_id = item.get("id")
        if not isinstance(item_id, str):
            raise ValueError("Collection items must have a string id")
        encoded = dumps_json(item)
        with self._write():
            self._db.execute(
                f"""INSERT INTO {table} (id, data, updated_at) VALUES (?, ?, datetime('now'))
                    ON CONFLICT(id) DO UPDATE SET data = excluded.data,
                                                  updated_at = datetime('now')""",
                (item_id, encoded),
            )
            self._write_version("record", collection, item_id)
        return item

    def remove(self, collection: str, id: str) -> bool:
        table = self._ensure_table(collection)
        with self._write():
            cursor = self._db.execute(f"DELETE FROM {table} WHERE id = ?", (id,))
            removed = cursor.rowcount > 0
            if removed:
                self._clear_version("record", collection, id)
        return removed

    def count(self, collection: str, filter: StoreFilter | None = None) -> int:
        table = self._ensure_table(collection)
        where = filter.get("where") if filter else None
        narrowed: StoreFilter = {"where": where} if where else {}
        where_clause, where_params = build_where_clause(narrowed)
        row = self._db.execute(
            f"SELECT COUNT(*) FROM {table}{where_clause}", tuple(where_params)
        ).fetchone()
        return int(row[0])

    # ── Atomic mutation ──────────────────────────────────────────────────
    def _table_if_exists(self, collection: str) -> str | None:
        """The collection's physical table, without creating it."""
        cached = self._tables.get(collection)
        table = cached or resolve_table(
            self._db, "collection", collection, legacy_collection_table(collection)
        )
        return table if table_exists(self._db, table) else None

    def _version_parts(self, target: dict[str, Any]) -> tuple[str, str, str]:
        if target["kind"] == "key":
            return ("key", "", target["key"])
        return ("record", target["collection"], target["id"])

    def _read_versioned_target(self, target: dict[str, Any]) -> dict[str, Any] | None:
        """The stored value and its token, minting one for a row that has none."""
        if target["kind"] == "key":
            row = self._db.execute(
                """SELECT k.value, v.version
                     FROM _kv AS k
                     LEFT JOIN _mirk_atomic_versions AS v
                       ON v.kind = 'key' AND v.collection = '' AND v.target_key = k.key
                    WHERE k.key = ?""",
                (target["key"],),
            ).fetchone()
            if row is None:
                return None
            encoded, version = row[0], row[1]
        else:
            table = self._table_if_exists(target["collection"])
            if table is None:
                return None
            row = self._db.execute(
                f"""SELECT c.data, v.version
                      FROM {table} AS c
                      LEFT JOIN _mirk_atomic_versions AS v
                        ON v.kind = 'record' AND v.collection = ? AND v.target_key = c.id
                     WHERE c.id = ?""",
                (target["collection"], target["id"]),
            ).fetchone()
            if row is None:
                return None
            encoded, version = row[0], row[1]
        if version is None:
            with self._write_scope():
                version = self._write_version(*self._version_parts(target))
        return {"value": json.loads(encoded), "version": str(version)}

    def getVersioned(self, target: dict[str, Any]) -> dict[str, Any] | None:
        """The value at a target and the token identifying this exact revision."""
        return self._read_versioned_target(target)

    def mutateAtomically(self, request: dict[str, Any]) -> dict[str, Any]:
        """Apply conditions and operations inside one BEGIN IMMEDIATE transaction."""
        validated = validate_atomic_request(request, self._atomic_limits)
        try:
            with self._write():
                return self._decide_atomic(validated)
        except sqlite3.OperationalError as error:
            message = str(error).lower()
            if "locked" in message or "busy" in message:
                raise AtomicMutationBackendError(
                    "unavailable", True, "SQLite is busy or locked."
                ) from error
            raise

    def _decide_atomic(self, validated: ValidatedRequest) -> dict[str, Any]:
        key = validated.idempotency_key
        if key is not None:
            prior = self._db.execute(
                "SELECT request_digest, result_json FROM _mirk_atomic_receipts"
                " WHERE idempotency_key = ?",
                (key,),
            ).fetchone()
            if prior is not None:
                if str(prior[0]) != validated.request_digest:
                    return {
                        "status": "idempotency-conflict",
                        "key": key,
                        "expectedRequestDigest": str(prior[0]),
                        "receivedRequestDigest": validated.request_digest,
                    }
                stored: dict[str, Any] = json.loads(prior[1])
                replayed: dict[str, Any] = {
                    "status": "replayed",
                    "requestDigest": stored["requestDigest"],
                    "versions": stored["versions"],
                }
                if "outcome" in stored:
                    replayed["outcome"] = stored["outcome"]
                return replayed

        for condition in validated.conditions:
            observed = self._read_versioned_target(condition["target"])
            if not condition_matches(condition, observed):
                return {
                    "status": "conflict",
                    "condition": clone_condition(condition),
                    "observed": (
                        "missing"
                        if observed is None
                        else observed["version"]
                        if condition["expected"] == "version"
                        else "present"
                    ),
                }

        versions: list[dict[str, Any]] = []
        for operation in validated.operations:
            target = operation_target(operation)
            parts = self._version_parts(target)
            op = operation["op"]
            if op == "set":
                self._db.execute(
                    """INSERT INTO _kv (key, value, updated_at) VALUES (?, ?, datetime('now'))
                       ON CONFLICT(key) DO UPDATE SET value = excluded.value,
                                                     updated_at = datetime('now')""",
                    (operation["key"], dumps_json(operation["value"])),
                )
                versions.append({"target": target, "version": self._write_version(*parts)})
            elif op == "delete":
                self._db.execute("DELETE FROM _kv WHERE key = ?", (operation["key"],))
                self._clear_version(*parts)
                versions.append({"target": target, "version": None})
            elif op == "put":
                table = self._ensure_table(operation["collection"])
                self._db.execute(
                    f"""INSERT INTO {table} (id, data, updated_at)
                        VALUES (?, ?, datetime('now'))
                        ON CONFLICT(id) DO UPDATE SET data = excluded.data,
                                                      updated_at = datetime('now')""",
                    (operation["item"]["id"], dumps_json(operation["item"])),
                )
                versions.append({"target": target, "version": self._write_version(*parts)})
            else:
                existing = self._table_if_exists(operation["collection"])
                if existing is not None:
                    self._db.execute(f"DELETE FROM {existing} WHERE id = ?", (operation["id"],))
                self._clear_version(*parts)
                versions.append({"target": target, "version": None})

        applied: dict[str, Any] = {
            "status": "applied",
            "requestDigest": validated.request_digest,
            "versions": versions,
        }
        if validated.has_outcome:
            applied["outcome"] = clone_json(validated.outcome)
        if key is not None:
            self._db.execute(
                "INSERT INTO _mirk_atomic_receipts"
                " (idempotency_key, request_digest, result_json) VALUES (?, ?, ?)",
                (key, validated.request_digest, dumps_json(applied)),
            )
        return applied


def connection_of(handle: object) -> sqlite3.Connection:
    """The ``sqlite3`` connection behind a store handle, or the connection itself."""
    if isinstance(handle, sqlite3.Connection):
        return handle
    candidate = getattr(handle, "connection", None)
    if isinstance(candidate, sqlite3.Connection):
        return candidate
    raise TypeError(f"no sqlite3 connection behind {type(handle).__name__}")
