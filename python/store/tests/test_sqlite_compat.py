"""Cross-language tests: the Python adapter and the TypeScript adapter share files.

These run the real TypeScript adapter out of ``packages/store/dist`` under Node
against a real SQLite file, so they prove interoperability rather than describing
it. ``@mirk/store`` is rebuilt once per session before anything runs, so a stale
bundle can never be what passed. A missing ``node`` or ``pnpm`` fails the suite
rather than skipping it: a silent skip here would retire the only evidence that
the two implementations share a file format.

``run_node_script`` is the reusable helper for the vector, search and graph
compatibility tests: hand it ESM source and argv, get back the JSON its last
stdout line printed.
"""

from __future__ import annotations

import json
import shutil
import sqlite3
import struct
import subprocess
from pathlib import Path
from typing import Any

import pytest

from mirk.store import SqliteStore, hash_name
from mirk.store.atomic import validate_atomic_request
from mirk.store.conformance import repo_root
from mirk.store.search import InMemorySearchStore
from mirk.store.sqlite_search import SqliteSearchFacet
from mirk.store.sqlite_vector import SqliteVectorFacet

REPO = repo_root()
DIST_SQLITE = REPO / "packages" / "store" / "dist" / "adapters" / "sqlite.js"
DIST_SQL = REPO / "packages" / "store" / "dist" / "sql.js"


@pytest.fixture(scope="session", autouse=True)
def dist_build() -> None:
    """Rebuild ``@mirk/store`` before any cross-language test reads the bundle."""
    node = shutil.which("node")
    assert node is not None, "node is required for the cross-language tests"
    pnpm = shutil.which("pnpm")
    assert pnpm is not None, "pnpm is required to build @mirk/store before these tests"
    completed = subprocess.run(
        [pnpm, "--filter", "@mirk/store", "build"],
        cwd=REPO,
        check=False,
        capture_output=True,
        text=True,
    )
    assert completed.returncode == 0, f"pnpm build failed:\n{completed.stdout}\n{completed.stderr}"
    assert DIST_SQLITE.is_file(), f"build did not produce {DIST_SQLITE}"
    assert DIST_SQL.is_file(), f"build did not produce {DIST_SQL}"


def run_node_script(script: str, tmp_path: Path, *args: str) -> Any:
    """Run ESM source under Node and parse the JSON its last stdout line printed.

    Import the built bundle by absolute path, as the scripts below do: Node then
    resolves ``better-sqlite3`` relative to the bundle, so the script itself can
    live in a temporary directory.
    """
    path = tmp_path / "script.mjs"
    path.write_text(script, encoding="utf-8")
    completed = subprocess.run(
        ["node", str(path), *args], check=False, capture_output=True, text=True
    )
    assert completed.returncode == 0, f"node failed:\n{completed.stderr}"
    return json.loads(completed.stdout.strip().splitlines()[-1])


WRITE_SCRIPT = f"""
import {{ SqliteAdapter }} from {json.dumps(str(DIST_SQLITE))};

const adapter = new SqliteAdapter({{ path: process.argv[2] }});
adapter.kv.set("greeting", {{
  hello: "from typescript",
  n: 1,
  f: 1.5,
  nil: null,
  nested: {{ z: [1, "two"] }},
}});
adapter.kv.put("things", {{ id: "t1", kind: "gear", weight: 2 }});
adapter.kv.put("things", {{ id: "t2", kind: "gear", weight: 1 }});
adapter.kv.put("things", {{ id: "t3", kind: "tool", weight: 3 }});
adapter.close();
console.log(JSON.stringify({{ ok: true }}));
"""


READBACK_SCRIPT = f"""
import {{ SqliteAdapter }} from {json.dumps(str(DIST_SQLITE))};

const adapter = new SqliteAdapter({{ path: process.argv[2] }});
const versioned = adapter.kv.getVersioned({{
  kind: "record",
  collection: "things",
  id: "p1",
}});
const out = {{
  fromPython: adapter.kv.get("from-python"),
  things: adapter.kv.list("things", {{ sortBy: "weight" }}),
  count: adapter.kv.count("things"),
  versionedValue: versioned ? versioned.value : null,
  version: versioned ? versioned.version : null,
}};
adapter.close();
console.log(JSON.stringify(out));
"""


NUMBER_SCRIPT = f"""
import {{ SqliteAdapter }} from {json.dumps(str(DIST_SQLITE))};

const adapter = new SqliteAdapter({{ path: process.argv[2] }});
adapter.kv.put("nums", {{
  id: "n1",
  whole: 1.0,
  zero: 0.0,
  big: 1e3,
  frac: 1.5,
  flag: true,
  nested: {{ inner: [2.0, 2.5] }},
}});
adapter.close();
console.log(JSON.stringify({{ ok: true }}));
"""


HASH_SCRIPT = f"""
import {{ hashName }} from {json.dumps(str(DIST_SQL))};

const names = JSON.parse(process.argv[2]);
console.log(JSON.stringify(names.map((name) => hashName(name))));
"""


def test_python_reads_what_typescript_wrote(tmp_path: Path) -> None:
    db = tmp_path / "ts-written.db"
    assert run_node_script(WRITE_SCRIPT, tmp_path, str(db)) == {"ok": True}

    store = SqliteStore(str(db))
    try:
        assert store.get("greeting") == {
            "hello": "from typescript",
            "n": 1,
            "f": 1.5,
            "nil": None,
            "nested": {"z": [1, "two"]},
        }
        assert store.keys() == ["greeting"]
        assert store.count("things") == 3
        assert store.list("things", {"sortBy": "weight"}) == [
            {"id": "t2", "kind": "gear", "weight": 1},
            {"id": "t1", "kind": "gear", "weight": 2},
            {"id": "t3", "kind": "tool", "weight": 3},
        ]
        assert store.list("things", {"where": {"kind": "gear"}, "sortBy": "weight"}) == [
            {"id": "t2", "kind": "gear", "weight": 1},
            {"id": "t1", "kind": "gear", "weight": 2},
        ]
    finally:
        store.close()


def test_typescript_reads_what_python_wrote(tmp_path: Path) -> None:
    db = tmp_path / "py-written.db"
    store = SqliteStore(str(db))
    try:
        store.set("from-python", {"hello": "from python", "n": 2})
        store.put("things", {"id": "p1", "kind": "gear", "weight": 0.5})
        store.put("things", {"id": "p2", "kind": "tool", "weight": 4})
    finally:
        store.close()

    # The bookkeeping row Python wrote, read straight out of the file. If the
    # write path skipped it, getVersioned would mint a fresh token on read and
    # this comparison would fail rather than pass silently.
    connection = sqlite3.connect(db)
    try:
        expected_version: str = connection.execute(
            "SELECT version FROM _mirk_atomic_versions"
            " WHERE kind = 'record' AND collection = 'things' AND target_key = 'p1'"
        ).fetchone()[0]
    finally:
        connection.close()

    result: dict[str, Any] = run_node_script(READBACK_SCRIPT, tmp_path, str(db))
    assert result["fromPython"] == {"hello": "from python", "n": 2}
    assert result["count"] == 2
    assert result["things"] == [
        {"id": "p1", "kind": "gear", "weight": 0.5},
        {"id": "p2", "kind": "tool", "weight": 4},
    ]
    assert result["versionedValue"] == {"id": "p1", "kind": "gear", "weight": 0.5}
    assert result["version"] == expected_version


def test_hash_name_matches_typescript(tmp_path: Path) -> None:
    # The astral-plane name is the point: a code-point hash and a code-unit hash
    # agree on everything else.
    names = ["things", "vecs", "docs", "foo-bar", "emoji \U0001f525", ""]
    expected: list[str] = run_node_script(HASH_SCRIPT, tmp_path, json.dumps(names))
    assert [hash_name(name) for name in names] == expected


def _stored_row(db: Path, table: str) -> tuple[str, list[str]]:
    connection = sqlite3.connect(db)
    try:
        text: str = connection.execute(f"SELECT data FROM {table} WHERE id = 'n1'").fetchone()[0]
        types = [
            connection.execute(
                f"SELECT json_type(data, '$.\"{field}\"') FROM {table} WHERE id = 'n1'"
            ).fetchone()[0]
            for field in ("whole", "zero", "big", "frac", "flag")
        ]
    finally:
        connection.close()
    return (text, types)


def test_integral_floats_are_written_the_way_javascript_writes_them(tmp_path: Path) -> None:
    """`json_type` must not report `real` where the TypeScript writer says `integer`."""
    table = f"c_nums_{hash_name('nums')}"

    ts_db = tmp_path / "ts-numbers.db"
    assert run_node_script(NUMBER_SCRIPT, tmp_path, str(ts_db)) == {"ok": True}

    py_db = tmp_path / "py-numbers.db"
    store = SqliteStore(str(py_db))
    try:
        store.put(
            "nums",
            {
                "id": "n1",
                "whole": 1.0,
                "zero": 0.0,
                "big": 1e3,
                "frac": 1.5,
                "flag": True,
                "nested": {"inner": [2.0, 2.5]},
            },
        )
    finally:
        store.close()

    ts_text, ts_types = _stored_row(ts_db, table)
    py_text, py_types = _stored_row(py_db, table)

    assert py_text == ts_text
    assert py_types == ts_types
    assert ts_types == ["integer", "integer", "integer", "real", "true"]


# ── Vector port ──────────────────────────────────────────────────────────────

VECTOR_WRITE_SCRIPT = f"""
import {{ SqliteAdapter }} from {json.dumps(str(DIST_SQLITE))};

const adapter = new SqliteAdapter({{ path: process.argv[2], dimensions: 3 }});
adapter.vector.upsert("vecs", {{
  id: "t1",
  vector: Float32Array.from([0.1, 0.2, 0.3]),
  metadata: {{ kind: "ts", nested: {{ n: 1, tags: ["a", "b"] }} }},
}});
adapter.vector.upsert("vecs", {{ id: "t2", vector: Float32Array.from([0.3, 0.2, 0.1]) }});
adapter.close();
console.log(JSON.stringify({{ ok: true }}));
"""


VECTOR_READBACK_SCRIPT = f"""
import {{ SqliteAdapter }} from {json.dumps(str(DIST_SQLITE))};

const adapter = new SqliteAdapter({{ path: process.argv[2] }});
const doc = adapter.vector.get("vecs", "p1");
const out = {{
  dimensions: adapter.vector.meta.dimensions,
  count: adapter.vector.count("vecs"),
  vector: doc ? Array.from(doc.vector) : null,
  metadata: doc ? (doc.metadata ?? null) : null,
  results: adapter.vector.search("vecs", Float32Array.from([0.25, 0.5, 0.75]), {{ topK: 5 }}),
}};
adapter.close();
console.log(JSON.stringify(out));
"""


def _vector_facet(db: Path) -> tuple[SqliteVectorFacet, sqlite3.Connection]:
    connection = sqlite3.connect(db, isolation_level=None)
    return (SqliteVectorFacet(connection, path=str(db)), connection)


def test_python_reads_the_vector_typescript_wrote(tmp_path: Path) -> None:
    db = tmp_path / "ts-vectors.db"
    assert run_node_script(VECTOR_WRITE_SCRIPT, tmp_path, str(db)) == {"ok": True}

    facet, connection = _vector_facet(db)
    try:
        # The blob is the contract: four little-endian bytes per component, and the
        # components are the float32 roundings of what the caller passed.
        blob: bytes = bytes(
            connection.execute(
                "SELECT vec FROM vectors WHERE collection = 'vecs' AND id = 't1'"
            ).fetchone()[0]
        )
        assert blob == struct.pack("<3f", 0.1, 0.2, 0.3)

        assert facet.meta["dimensions"] == 3
        doc = facet.get("vecs", "t1")
        assert doc is not None
        assert doc["vector"] == list(struct.unpack("<3f", struct.pack("<3f", 0.1, 0.2, 0.3)))
        assert doc.get("metadata") == {"kind": "ts", "nested": {"n": 1, "tags": ["a", "b"]}}

        plain = facet.get("vecs", "t2")
        assert plain is not None
        assert "metadata" not in plain

        found = facet.search("vecs", [0.1, 0.2, 0.3], {"topK": 1})
        assert [hit["id"] for hit in found] == ["t1"]
        assert found[0]["score"] == pytest.approx(1.0, abs=1e-6)
    finally:
        connection.close()


def test_typescript_searches_the_vector_python_wrote(tmp_path: Path) -> None:
    db = tmp_path / "py-vectors.db"
    facet, connection = _vector_facet(db)
    try:
        facet.upsert(
            "vecs",
            {"id": "p1", "vector": [0.25, 0.5, 0.75], "metadata": {"kind": "py", "n": 2}},
        )
        facet.upsert("vecs", {"id": "p2", "vector": [1.0, 0.0, 0.0]})
    finally:
        connection.close()

    result: dict[str, Any] = run_node_script(VECTOR_READBACK_SCRIPT, tmp_path, str(db))
    # Dimensions came from the `_vec_meta` row Python wrote; without it the adapter
    # would refuse to search at all.
    assert result["dimensions"] == 3
    assert result["count"] == 2
    assert result["vector"] == list(struct.unpack("<3f", struct.pack("<3f", 0.25, 0.5, 0.75)))
    assert result["metadata"] == {"kind": "py", "n": 2}

    hits: list[dict[str, Any]] = result["results"]
    assert [hit["id"] for hit in hits] == ["p1", "p2"]
    assert hits[0]["score"] == pytest.approx(1.0, abs=1e-6)


SEARCH_WRITE_SCRIPT = f"""
import {{ SqliteAdapter }} from {json.dumps(str(DIST_SQLITE))};

const adapter = new SqliteAdapter({{ path: process.argv[2] }});
adapter.search.indexMany("notes", [
  {{ id: "a", text: "the quick brown fox jumps", meta: {{ kind: "fable" }} }},
  {{ id: "b", text: "a fox and a hound and a fox", meta: {{ kind: "fable" }} }},
  {{ id: "c", text: "an unrelated document about badgers" }},
]);
adapter.search.index("fielded", {{
  id: "f1",
  fields: {{ title: "fox", body: "hound" }},
  meta: {{ kind: "fielded" }},
}});
const hits = adapter.search.search("notes", "fox");
adapter.close();
console.log(
  JSON.stringify({{ ids: hits.map((hit) => hit.id), metas: hits.map((hit) => hit.meta) }}),
);
"""


SEARCH_READBACK_SCRIPT = f"""
import {{ SqliteAdapter }} from {json.dumps(str(DIST_SQLITE))};

const adapter = new SqliteAdapter({{ path: process.argv[2] }});
const hits = adapter.search.search("py-notes", "badger");
const weighted = adapter.search.search("py-fielded", "fox", {{
  fieldWeights: {{ title: 5, body: 1 }},
}});
let fieldsError = null;
try {{
  adapter.search.index("py-fielded", {{ id: "bad", text: "wrong shape" }});
}} catch (error) {{
  fieldsError = error.message;
}}
adapter.close();
console.log(JSON.stringify({{
  ids: hits.map((hit) => hit.id),
  metas: hits.map((hit) => hit.meta),
  weighted: weighted.map((hit) => hit.id),
  fieldsError,
}}));
"""


def test_python_searches_what_typescript_indexed(tmp_path: Path) -> None:
    """The TypeScript facet writes the FTS5 tables; the Python facet ranks them the same."""
    db = tmp_path / "ts-search.db"
    written: dict[str, Any] = run_node_script(SEARCH_WRITE_SCRIPT, tmp_path, str(db))
    assert written["ids"] == ["b", "a"]

    store = SqliteStore(str(db))
    try:
        facet = SqliteSearchFacet(store)
        hits = facet.search("notes", "fox")
        assert [hit["id"] for hit in hits] == written["ids"]
        assert [hit["meta"] for hit in hits] == written["metas"]
        assert [hit["id"] for hit in facet.search("notes", "badgers")] == ["c"]
        # The schema row TypeScript wrote pins the fields for the Python writer too.
        with pytest.raises(ValueError, match="was initialized with fields"):
            facet.index("fielded", {"id": "f2", "text": "wrong shape"})
    finally:
        store.close()

    # Same corpus, same query, in-memory reference: the ranking is the contract.
    memory = InMemorySearchStore()
    memory.indexMany(
        "notes",
        [
            {"id": "a", "text": "the quick brown fox jumps", "meta": {"kind": "fable"}},
            {"id": "b", "text": "a fox and a hound and a fox", "meta": {"kind": "fable"}},
            {"id": "c", "text": "an unrelated document about badgers"},
        ],
    )
    assert [hit["id"] for hit in memory.search("notes", "fox")] == written["ids"]


def test_typescript_searches_what_python_indexed(tmp_path: Path) -> None:
    db = tmp_path / "py-search.db"
    store = SqliteStore(str(db))
    try:
        facet = SqliteSearchFacet(store)
        facet.indexMany(
            "py-notes",
            [
                {"id": "p1", "text": "a badger writes python", "meta": {"kind": "note"}},
                {"id": "p2", "text": "badger badger badger", "meta": {"kind": "note"}},
                {"id": "p3", "text": "no mention here"},
            ],
        )
        facet.index("py-fielded", {"id": "t1", "fields": {"title": "fox", "body": "x"}})
        facet.index("py-fielded", {"id": "b1", "fields": {"title": "x", "body": "fox"}})
        python_order = [hit["id"] for hit in facet.search("py-notes", "badger")]
        python_weighted = [
            hit["id"]
            for hit in facet.search("py-fielded", "fox", {"fieldWeights": {"title": 5, "body": 1}})
        ]
    finally:
        store.close()

    result: dict[str, Any] = run_node_script(SEARCH_READBACK_SCRIPT, tmp_path, str(db))
    assert result["ids"] == python_order == ["p2", "p1"]
    assert result["metas"] == [{"kind": "note"}, {"kind": "note"}]
    assert result["weighted"] == python_weighted == ["t1", "b1"]
    # The registry row Python wrote is what makes TypeScript reject the wrong shape.
    assert result["fieldsError"] == (
        'Search collection "py-fielded" was initialized with fields [body, title], got [text].'
    )


# ── Physical table registry (MR-21) ──────────────────────────────────────────
# Both names sanitize to six underscores and hash to "jqoxun", so before the
# registry the two languages agreed only in aliasing them onto one table.
COLLIDE_A = "%$;**@"
COLLIDE_B = "~,~$(*"
COLLIDE_TABLE = "c________jqoxun"
COLLIDE_SEARCH_TABLE = "search_docs________jqoxun"


COLLISION_WRITE_SCRIPT = f"""
import {{ SqliteAdapter }} from {json.dumps(str(DIST_SQLITE))};

const adapter = new SqliteAdapter({{ path: process.argv[2] }});
adapter.kv.put(process.argv[3], {{ id: "x", which: "a" }});
adapter.kv.put(process.argv[4], {{ id: "x", which: "b" }});
adapter.search.index(process.argv[3], {{ id: "sa", text: "the quick brown fox" }});
adapter.search.index(process.argv[4], {{ id: "sb", text: "a slow grey badger" }});
adapter.close();
console.log(JSON.stringify({{ ok: true }}));
"""


COLLISION_READBACK_SCRIPT = f"""
import {{ SqliteAdapter }} from {json.dumps(str(DIST_SQLITE))};

const adapter = new SqliteAdapter({{ path: process.argv[2] }});
const out = {{
  a: adapter.kv.getById(process.argv[3], "x"),
  b: adapter.kv.getById(process.argv[4], "x"),
  countA: adapter.kv.count(process.argv[3]),
  countB: adapter.kv.count(process.argv[4]),
  searchA: adapter.search.search(process.argv[3], "fox").map((hit) => hit.id),
  searchB: adapter.search.search(process.argv[4], "badger").map((hit) => hit.id),
  crossA: adapter.search.search(process.argv[3], "badger").map((hit) => hit.id),
  crossB: adapter.search.search(process.argv[4], "fox").map((hit) => hit.id),
}};
adapter.close();
console.log(JSON.stringify(out));
"""


LEGACY_READ_SCRIPT = f"""
import {{ SqliteAdapter }} from {json.dumps(str(DIST_SQLITE))};

const adapter = new SqliteAdapter({{ path: process.argv[2] }});
const things = adapter.kv.list("things", {{ sortBy: "n" }});
adapter.close();
console.log(JSON.stringify({{ things }}));
"""


def _registry_rows(path: Path) -> list[tuple[str, str, str]]:
    connection = sqlite3.connect(str(path))
    try:
        return [
            (str(kind), str(name), str(table))
            for kind, name, table in connection.execute(
                "SELECT kind, name, table_name FROM _mirk_tables ORDER BY kind, name"
            )
        ]
    finally:
        connection.close()


def _collection_tables(path: Path) -> list[str]:
    connection = sqlite3.connect(str(path))
    try:
        return [
            str(name)
            for (name,) in connection.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'c_things%'"
                " ORDER BY name"
            )
        ]
    finally:
        connection.close()


def _require_typescript_registry(path: Path) -> None:
    connection = sqlite3.connect(str(path))
    try:
        present = connection.execute(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '_mirk_tables'"
        ).fetchone()
    finally:
        connection.close()
    assert present is not None, "TypeScript registry not built yet"


def test_python_reads_the_colliding_collections_typescript_wrote(tmp_path: Path) -> None:
    """Two names that share a sanitized form and a hash stay two tables across languages."""
    db = tmp_path / "ts-collide.db"
    run_node_script(COLLISION_WRITE_SCRIPT, tmp_path, str(db), COLLIDE_A, COLLIDE_B)
    _require_typescript_registry(db)
    assert _registry_rows(db) == [
        ("collection", COLLIDE_A, COLLIDE_TABLE),
        ("collection", COLLIDE_B, f"{COLLIDE_TABLE}_2"),
        ("search", COLLIDE_A, COLLIDE_SEARCH_TABLE),
        ("search", COLLIDE_B, f"{COLLIDE_SEARCH_TABLE}_2"),
    ]

    store = SqliteStore(str(db))
    try:
        assert store.getById(COLLIDE_A, "x") == {"id": "x", "which": "a"}
        assert store.getById(COLLIDE_B, "x") == {"id": "x", "which": "b"}
        assert store.count(COLLIDE_A) == 1
        assert store.count(COLLIDE_B) == 1
        facet = SqliteSearchFacet(store)
        assert [hit["id"] for hit in facet.search(COLLIDE_A, "fox")] == ["sa"]
        assert [hit["id"] for hit in facet.search(COLLIDE_B, "badger")] == ["sb"]
        assert facet.search(COLLIDE_A, "badger") == []
        assert facet.search(COLLIDE_B, "fox") == []
    finally:
        store.close()


def test_typescript_reads_the_colliding_collections_python_wrote(tmp_path: Path) -> None:
    db = tmp_path / "py-collide.db"
    store = SqliteStore(str(db))
    try:
        store.put(COLLIDE_A, {"id": "x", "which": "a"})
        store.put(COLLIDE_B, {"id": "x", "which": "b"})
        facet = SqliteSearchFacet(store)
        facet.index(COLLIDE_A, {"id": "sa", "text": "the quick brown fox"})
        facet.index(COLLIDE_B, {"id": "sb", "text": "a slow grey badger"})
    finally:
        store.close()

    result: dict[str, Any] = run_node_script(
        COLLISION_READBACK_SCRIPT, tmp_path, str(db), COLLIDE_A, COLLIDE_B
    )
    assert result["a"] == {"id": "x", "which": "a"}
    assert result["b"] == {"id": "x", "which": "b"}
    assert result["countA"] == result["countB"] == 1
    assert result["searchA"] == ["sa"]
    assert result["searchB"] == ["sb"]
    assert result["crossA"] == []
    assert result["crossB"] == []


LEGACY_SQL = """
CREATE TABLE _kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE _mirk_atomic_versions (
  kind TEXT NOT NULL, collection TEXT NOT NULL, target_key TEXT NOT NULL,
  version TEXT NOT NULL, PRIMARY KEY (kind, collection, target_key)
);
CREATE TABLE _mirk_atomic_sequence (
  id INTEGER PRIMARY KEY CHECK (id = 1), value INTEGER NOT NULL
);
CREATE TABLE _mirk_atomic_receipts (
  idempotency_key TEXT PRIMARY KEY, request_digest TEXT NOT NULL, result_json TEXT NOT NULL
);
CREATE TABLE _mirk_atomic_identity (
  id INTEGER PRIMARY KEY CHECK (id = 1), value TEXT NOT NULL
);
CREATE TABLE c_things_17yznec (
  id TEXT PRIMARY KEY,
  data JSON NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
INSERT INTO _mirk_atomic_sequence (id, value) VALUES (1, 1);
INSERT INTO _mirk_atomic_identity (id, value) VALUES (1, 'legacy-identity');
INSERT INTO c_things_17yznec (id, data)
  VALUES ('t1', '{"id":"t1","n":1}'), ('t2', '{"id":"t2","n":2}');
"""


def _write_legacy_file(path: Path) -> None:
    """A pre-MR-21 file written with raw SQL: hashed table names, no registry."""
    connection = sqlite3.connect(str(path), isolation_level=None)
    try:
        connection.executescript(LEGACY_SQL)
    finally:
        connection.close()


def test_both_languages_adopt_the_same_legacy_table(tmp_path: Path) -> None:
    """A file written before the registry keeps its table, whichever language opens it."""
    expected_rows = [("collection", "things", "c_things_17yznec")]
    expected_things = [{"id": "t1", "n": 1}, {"id": "t2", "n": 2}]

    ts_first = tmp_path / "legacy-ts.db"
    _write_legacy_file(ts_first)
    result: dict[str, Any] = run_node_script(LEGACY_READ_SCRIPT, tmp_path, str(ts_first))
    assert result["things"] == expected_things
    _require_typescript_registry(ts_first)
    assert _registry_rows(ts_first) == expected_rows
    # Adoption is in place: TypeScript did not create a second physical table.
    assert _collection_tables(ts_first) == ["c_things_17yznec"]

    py_first = tmp_path / "legacy-py.db"
    _write_legacy_file(py_first)
    store = SqliteStore(str(py_first))
    try:
        assert store.list("things", {"sortBy": "n"}) == expected_things
    finally:
        store.close()
    assert _registry_rows(py_first) == expected_rows

    # The language that opened second sees the row the first one wrote.
    second: dict[str, Any] = run_node_script(LEGACY_READ_SCRIPT, tmp_path, str(py_first))
    assert second["things"] == expected_things
    assert _registry_rows(py_first) == expected_rows
    store = SqliteStore(str(ts_first))
    try:
        assert store.list("things", {"sortBy": "n"}) == expected_things
    finally:
        store.close()
    assert _registry_rows(ts_first) == [("collection", "things", "c_things_17yznec")]


SQUATTER_WRITE_SCRIPT = f"""
import {{ SqliteAdapter }} from {json.dumps(str(DIST_SQLITE))};

const adapter = new SqliteAdapter({{ path: process.argv[2] }});
adapter.kv.put(process.argv[4], {{ id: "x", which: "b" }});
const out = {{
  a: adapter.kv.getById(process.argv[3], "x"),
  b: adapter.kv.getById(process.argv[4], "x"),
  countA: adapter.kv.count(process.argv[3]),
  countB: adapter.kv.count(process.argv[4]),
}};
adapter.close();
console.log(JSON.stringify(out));
"""


SQUATTER_SQL = f"""
CREATE TABLE _kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE _mirk_atomic_versions (
  kind TEXT NOT NULL, collection TEXT NOT NULL, target_key TEXT NOT NULL,
  version TEXT NOT NULL, PRIMARY KEY (kind, collection, target_key)
);
CREATE TABLE _mirk_atomic_sequence (
  id INTEGER PRIMARY KEY CHECK (id = 1), value INTEGER NOT NULL
);
CREATE TABLE _mirk_atomic_receipts (
  idempotency_key TEXT PRIMARY KEY, request_digest TEXT NOT NULL, result_json TEXT NOT NULL
);
CREATE TABLE _mirk_atomic_identity (
  id INTEGER PRIMARY KEY CHECK (id = 1), value TEXT NOT NULL
);
CREATE TABLE _mirk_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE _mirk_tables (
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  table_name TEXT NOT NULL UNIQUE,
  PRIMARY KEY (kind, name)
);
CREATE TABLE {COLLIDE_TABLE} (
  id TEXT PRIMARY KEY,
  data JSON NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
-- An unregistered table already sitting on the second candidate. Same shape as a
-- collection table, so a wrong resolution reads it as data rather than erroring.
CREATE TABLE {COLLIDE_TABLE}_2 (
  id TEXT PRIMARY KEY,
  data JSON NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
INSERT INTO _mirk_atomic_sequence (id, value) VALUES (1, 1);
INSERT INTO _mirk_atomic_identity (id, value) VALUES (1, 'squatter-identity');
INSERT INTO _mirk_meta (key, value) VALUES ('schema_version', '2');
INSERT INTO _mirk_tables (kind, name, table_name)
  VALUES ('collection', '{COLLIDE_A}', '{COLLIDE_TABLE}');
INSERT INTO {COLLIDE_TABLE} (id, data) VALUES ('x', '{{"id":"x","which":"a"}}');
INSERT INTO {COLLIDE_TABLE}_2 (id, data) VALUES ('foreign', '{{"id":"foreign"}}');
"""


def _write_squatter_file(path: Path) -> None:
    """The first colliding name registered, and an unclaimed table on ``_2``."""
    connection = sqlite3.connect(str(path), isolation_level=None)
    try:
        connection.executescript(SQUATTER_SQL)
    finally:
        connection.close()


def _squatter_rows(path: Path) -> list[tuple[str, str]]:
    connection = sqlite3.connect(str(path))
    try:
        return [
            (str(id), str(data))
            for id, data in connection.execute(f"SELECT id, data FROM {COLLIDE_TABLE}_2")
        ]
    finally:
        connection.close()


def test_both_languages_skip_an_occupied_suffixed_candidate(tmp_path: Path) -> None:
    """An unregistered table on ``_2`` is stepped over by both languages alike.

    Only the exact legacy name is ever adopted. A stray table on a suffixed
    candidate would otherwise be picked up by ``CREATE TABLE IF NOT EXISTS`` and
    read back as the second collection's rows.
    """
    expected_a = {"id": "x", "which": "a"}
    expected_b = {"id": "x", "which": "b"}
    expected_squatter = [("foreign", '{"id":"foreign"}')]

    py_first = tmp_path / "squatter-py.db"
    _write_squatter_file(py_first)
    store = SqliteStore(str(py_first))
    try:
        store.put(COLLIDE_B, {"id": "x", "which": "b"})
        assert store.getById(COLLIDE_A, "x") == expected_a
        assert store.getById(COLLIDE_B, "x") == expected_b
        assert store.count(COLLIDE_B) == 1
    finally:
        store.close()
    assert _registry_rows(py_first) == [
        ("collection", COLLIDE_A, COLLIDE_TABLE),
        ("collection", COLLIDE_B, f"{COLLIDE_TABLE}_3"),
    ]
    assert _squatter_rows(py_first) == expected_squatter

    ts_first = tmp_path / "squatter-ts.db"
    _write_squatter_file(ts_first)
    result: dict[str, Any] = run_node_script(
        SQUATTER_WRITE_SCRIPT, tmp_path, str(ts_first), COLLIDE_A, COLLIDE_B
    )
    assert result["a"] == expected_a
    assert result["b"] == expected_b
    assert result["countA"] == result["countB"] == 1
    assert _registry_rows(ts_first) == [
        ("collection", COLLIDE_A, COLLIDE_TABLE),
        ("collection", COLLIDE_B, f"{COLLIDE_TABLE}_3"),
    ]
    assert _squatter_rows(ts_first) == expected_squatter

    # Each language then reads the file the other resolved, off the same rows.
    crossed: dict[str, Any] = run_node_script(
        COLLISION_READBACK_SCRIPT, tmp_path, str(py_first), COLLIDE_A, COLLIDE_B
    )
    assert crossed["a"] == expected_a
    assert crossed["b"] == expected_b
    store = SqliteStore(str(ts_first))
    try:
        assert store.getById(COLLIDE_A, "x") == expected_a
        assert store.getById(COLLIDE_B, "x") == expected_b
    finally:
        store.close()
    assert _squatter_rows(ts_first) == expected_squatter


# ── Atomic mutation across the two languages ────────────────────────────────

DIST_ATOMIC = REPO / "packages" / "store" / "dist" / "atomic.js"

DIGEST_SCRIPT = f"""
import {{ validateAtomicRequest }} from {json.dumps(str(DIST_ATOMIC))};

const requests = JSON.parse(process.argv[2]);
console.log(
  JSON.stringify(requests.map((request) => validateAtomicRequest(request).requestDigest))
);
"""

# Raw JSON text, not a Python literal: the same bytes reach `json.loads` here and
# `JSON.parse` under Node, so neither language's writer can quietly normalize a
# case away before the digest sees it.
DIGEST_REQUESTS_JSON = """[
  {"operations": [{"op": "set", "key": "z", "value": {"deep": [-0.0, {"also": -0.0}]}}]},
  {"operations": [{"op": "set", "key": "z", "value": {"deep": [0, {"also": 0}]}}]},
  {"operations": [{"op": "set", "key": "k\\u00e9y",
    "value": {"\\uffff": 1, "\\ud83d\\ude00": 2, "a": 3}}]},
  {"operations": [{"op": "set", "key": "n", "value": {"a": 100.0, "b": 100}}]},
  {"operations": [{"op": "set", "key": "n", "value": {"a": 100, "b": 100.0}}]},
  {
    "conditions": [
      {"target": {"kind": "record", "collection": "c", "id": "a"}, "expected": "present"},
      {"target": {"kind": "key", "key": "b"}, "expected": "missing"}
    ],
    "operations": [{"op": "put", "collection": "c", "item": {"id": "a", "n": 1}}],
    "idempotency": {"key": "ignored-by-the-digest", "outcome": {"ok": true}}
  },
  {
    "conditions": [
      {"target": {"kind": "key", "key": "b"}, "expected": "missing"},
      {"target": {"kind": "record", "collection": "c", "id": "a"}, "expected": "present"}
    ],
    "operations": [{"op": "put", "collection": "c", "item": {"id": "a", "n": 1}}],
    "idempotency": {"key": "a-different-key", "outcome": {"ok": true}}
  }
]"""


def test_request_digests_match_the_real_typescript(tmp_path: Path) -> None:
    """The canonical-JSON contract, pinned against the shipped implementation.

    Every digest here is produced twice: once by `mirk.store.atomic` and once by
    `validateAtomicRequest` out of the built bundle under Node. Nothing is
    hard-coded, so the assertion cannot pass by copying a stale constant.
    """
    requests: list[Any] = json.loads(DIGEST_REQUESTS_JSON)
    mine = [validate_atomic_request(request).request_digest for request in requests]
    theirs: list[str] = run_node_script(DIGEST_SCRIPT, tmp_path, DIGEST_REQUESTS_JSON)
    assert mine == theirs

    # A negative zero anywhere inside the value is the same request as a zero.
    assert mine[0] == mine[1]
    # An integral float and an int are one JSON number.
    assert mine[3] == mine[4]
    # Conditions sort before the digest and the idempotency key is excluded, so
    # the last two requests are one request identity.
    assert mine[5] == mine[6]
    # The astral key really participates: it is not silently dropped.
    assert len({*mine}) == 4


ATOMIC_TS_WRITE_SCRIPT = f"""
import {{ SqliteAdapter }} from {json.dumps(str(DIST_SQLITE))};

const adapter = new SqliteAdapter({{ path: process.argv[2], versionIdentity: "ts" }});
adapter.kv.set("seed", {{ n: 1 }});
adapter.kv.set("doomed", true);
adapter.kv.put("things", {{ id: "ghost", weight: 9 }});
const seed = adapter.kv.getVersioned({{ kind: "key", key: "seed" }});
const request = {{
  conditions: [
    {{ target: {{ kind: "key", key: "fresh" }}, expected: "missing" }},
    {{
      target: {{ kind: "key", key: "seed" }},
      expected: "version",
      version: seed.version,
    }},
  ],
  operations: [
    {{ op: "set", key: "fresh", value: {{ from: "ts", ratio: 1.5, whole: 2.0 }} }},
    {{ op: "put", collection: "things", item: {{ id: "t1", weight: 2 }} }},
    {{ op: "delete", key: "doomed" }},
    {{ op: "remove", collection: "things", id: "ghost" }},
  ],
  idempotency: {{ key: "k1", outcome: {{ accepted: true, at: "ts" }} }},
}};
const result = adapter.kv.mutateAtomically(request);
const conflicting = {{
  operations: [{{ op: "set", key: "fresh", value: "different" }}],
  idempotency: {{ key: "k1" }},
}};
adapter.close();
console.log(JSON.stringify({{ result, seedVersion: seed.version, request, conflicting }}));
"""


ATOMIC_TS_READBACK_SCRIPT = f"""
import {{ SqliteAdapter }} from {json.dumps(str(DIST_SQLITE))};

const payload = JSON.parse(process.argv[3]);
const adapter = new SqliteAdapter({{ path: process.argv[2], versionIdentity: "never-used" }});
const out = {{
  versions: payload.targets.map((target) => adapter.kv.getVersioned(target)),
  replay: adapter.kv.mutateAtomically(payload.request),
  conflict: adapter.kv.mutateAtomically(payload.conflicting),
}};
adapter.close();
console.log(JSON.stringify(out));
"""


def _version_number(token: str) -> int:
    prefix, _, number = token.rpartition("-v")
    assert prefix == "ts", f"token {token!r} does not carry the file's identity"
    return int(number)


def test_atomic_mutation_round_trips_between_the_two_languages(tmp_path: Path) -> None:
    """TypeScript mutates a file atomically; Python replays it, then the reverse.

    Both directions assert on the version tokens and on the request digest, so
    the sequence, the persisted identity, the receipt table and the canonical
    request encoding are all proven shared rather than described as shared.
    """
    db = tmp_path / "atomic-exchange.db"
    written: dict[str, Any] = run_node_script(ATOMIC_TS_WRITE_SCRIPT, tmp_path, str(db))
    ts_result: dict[str, Any] = written["result"]
    assert ts_result["status"] == "applied"

    store = SqliteStore(str(db), version_identity="python-would-have-used-this")
    try:
        # (a) Python reads the tokens TypeScript minted, out of the same file.
        fresh = store.getVersioned({"kind": "key", "key": "fresh"})
        record = store.getVersioned({"kind": "record", "collection": "things", "id": "t1"})
        assert fresh is not None and record is not None
        assert fresh == {
            "value": {"from": "ts", "ratio": 1.5, "whole": 2},
            "version": ts_result["versions"][0]["version"],
        }
        assert record["version"] == ts_result["versions"][1]["version"]
        assert _version_number(fresh["version"]) > _version_number(written["seedVersion"])
        # The delete and the remove dropped their tokens on both sides.
        assert store.getVersioned({"kind": "key", "key": "doomed"}) is None
        assert store.getVersioned({"kind": "record", "collection": "things", "id": "ghost"}) is None

        # Python replays TypeScript's request under the same key and gets the
        # receipt TypeScript wrote, digest and version tokens included.
        replay = store.mutateAtomically(written["request"])
        assert replay["status"] == "replayed"
        assert {key: value for key, value in replay.items() if key != "status"} == {
            key: value for key, value in ts_result.items() if key != "status"
        }

        # A different request under the same key is refused, and the digest it
        # was measured against is the one TypeScript computed.
        conflict = store.mutateAtomically(written["conflicting"])
        assert conflict["status"] == "idempotency-conflict"
        assert conflict["expectedRequestDigest"] == ts_result["requestDigest"]
        assert conflict["receivedRequestDigest"] != ts_result["requestDigest"]

        # (b) Python now writes its own atomic mutation into the same file.
        python_request: dict[str, Any] = {
            "conditions": [
                {
                    "target": {"kind": "key", "key": "fresh"},
                    "expected": "version",
                    "version": fresh["version"],
                }
            ],
            "operations": [
                {"op": "set", "key": "from-python", "value": {"n": 3}},
                {"op": "put", "collection": "things", "item": {"id": "p1", "weight": 1}},
            ],
            "idempotency": {"key": "k2", "outcome": {"accepted": True, "at": "python"}},
        }
        python_result = store.mutateAtomically(python_request)
        assert python_result["status"] == "applied"
        # Python continued the file's sequence and identity, not its own.
        assert _version_number(python_result["versions"][0]["version"]) == (
            _version_number(record["version"]) + 1
        )
    finally:
        store.close()

    payload = json.dumps(
        {
            "targets": [
                {"kind": "key", "key": "from-python"},
                {"kind": "record", "collection": "things", "id": "p1"},
            ],
            "request": python_request,
            "conflicting": {
                "operations": [{"op": "set", "key": "from-python", "value": "other"}],
                "idempotency": {"key": "k2"},
            },
        }
    )
    back: dict[str, Any] = run_node_script(ATOMIC_TS_READBACK_SCRIPT, tmp_path, str(db), payload)
    assert [entry["version"] for entry in back["versions"]] == [
        entry["version"] for entry in python_result["versions"]
    ]
    assert back["versions"][0]["value"] == {"n": 3}
    assert back["replay"]["status"] == "replayed"
    assert back["replay"]["requestDigest"] == python_result["requestDigest"]
    assert back["replay"]["versions"] == python_result["versions"]
    assert back["replay"]["outcome"] == {"accepted": True, "at": "python"}
    assert back["conflict"]["status"] == "idempotency-conflict"
    assert back["conflict"]["expectedRequestDigest"] == python_result["requestDigest"]


LEGACY_TS_WRITE_SCRIPT = f"""
import {{ SqliteAdapter }} from {json.dumps(str(DIST_SQLITE))};

const adapter = new SqliteAdapter({{ path: process.argv[2], versionIdentity: "ts" }});
adapter.kv.set("plain", {{ n: 1 }});
adapter.kv.put("things", {{ id: "t1", weight: 2 }});
const out = {{
  key: adapter.kv.getVersioned({{ kind: "key", key: "plain" }}).version,
  record: adapter.kv.getVersioned({{
    kind: "record",
    collection: "things",
    id: "t1",
  }}).version,
}};
adapter.close();
console.log(JSON.stringify(out));
"""


LEGACY_TS_READ_SCRIPT = f"""
import {{ SqliteAdapter }} from {json.dumps(str(DIST_SQLITE))};

const adapter = new SqliteAdapter({{ path: process.argv[2], versionIdentity: "never-used" }});
const out = {{
  key: adapter.kv.getVersioned({{ kind: "key", key: "plain" }}),
  record: adapter.kv.getVersioned({{ kind: "record", collection: "things", id: "t1" }}),
}};
adapter.close();
console.log(JSON.stringify(out));
"""


def test_plain_writes_carry_version_tokens_across_languages(tmp_path: Path) -> None:
    """`set` and `put` mint tokens in both languages, and each reads the other's."""
    ts_db = tmp_path / "legacy-ts.db"
    ts_tokens: dict[str, str] = run_node_script(LEGACY_TS_WRITE_SCRIPT, tmp_path, str(ts_db))
    store = SqliteStore(str(ts_db))
    try:
        key_read = store.getVersioned({"kind": "key", "key": "plain"})
        record_read = store.getVersioned({"kind": "record", "collection": "things", "id": "t1"})
        assert key_read is not None and record_read is not None
        # The tokens TypeScript's plain writes persisted, not freshly minted ones.
        assert key_read["version"] == ts_tokens["key"]
        assert record_read["version"] == ts_tokens["record"]
    finally:
        store.close()

    py_db = tmp_path / "legacy-py.db"
    writer = SqliteStore(str(py_db), version_identity="ts")
    try:
        writer.set("plain", {"n": 1})
        writer.put("things", {"id": "t1", "weight": 2})
        expected_key = writer.getVersioned({"kind": "key", "key": "plain"})
        expected_record = writer.getVersioned(
            {"kind": "record", "collection": "things", "id": "t1"}
        )
        assert expected_key is not None and expected_record is not None
    finally:
        writer.close()

    read_back: dict[str, Any] = run_node_script(LEGACY_TS_READ_SCRIPT, tmp_path, str(py_db))
    assert read_back["key"] == expected_key
    assert read_back["record"] == expected_record
