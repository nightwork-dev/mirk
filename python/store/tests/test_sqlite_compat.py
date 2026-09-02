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
    resolves ``better-sqlite3`` and ``sqlite-vec`` relative to the bundle, so the
    script itself can live in a temporary directory.
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
  accelerated: adapter.vector.meta.accelerated,
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
