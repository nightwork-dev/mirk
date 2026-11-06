"""Format migration and named-vector file exchange through both Node drivers."""

from __future__ import annotations

import json
import sqlite3
import struct
from pathlib import Path

import pytest

from mirk.store.sqlite import SqliteAdapterError, SqliteStore, ensure_registry
from mirk.store.sqlite_vector import SqliteVectorFacet
from test_sqlite_compat import REPO, run_node_script


def legacy_file(path: Path, blob: bytes) -> None:
    connection = sqlite3.connect(path, isolation_level=None)
    connection.executescript("""
      CREATE TABLE _mirk_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      INSERT INTO _mirk_meta VALUES('schema_version','2');
      CREATE TABLE _mirk_tables(kind TEXT,name TEXT,table_name TEXT UNIQUE,PRIMARY KEY(kind,name));
      CREATE TABLE vectors(collection TEXT,id TEXT,vec BLOB,metadata TEXT,
        PRIMARY KEY(collection,id));
      CREATE TABLE _vec_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      INSERT INTO _vec_meta VALUES('dimensions','2');
      CREATE TABLE app(value TEXT);INSERT INTO app VALUES('preserved');
    """)
    connection.execute("INSERT INTO vectors VALUES('docs','a',?,NULL)", (blob,))
    connection.close()


def test_python_migration_preserves_bytes_and_application_tables(tmp_path: Path) -> None:
    path = tmp_path / "legacy.db"
    blob = struct.pack("<2f", 1.0, 0.0)
    legacy_file(path, blob)
    store = SqliteStore(str(path))
    try:
        facet = SqliteVectorFacet(store.connection)
        assert facet.listSpaces()[0]["name"] == "default"
        assert facet.get("docs", "a") == {"id": "a", "vectors": {"default": [1.0, 0.0]}}
        assert store.connection.execute("SELECT vec FROM _mirk_vector_values").fetchone()[0] == blob
        assert store.connection.execute("SELECT value FROM app").fetchone()[0] == "preserved"
    finally:
        store.close()


def test_failed_and_readonly_migrations_leave_version_two(tmp_path: Path) -> None:
    for label, blob, readonly, code in (
        ("invalid", b"bad", False, "malformed-schema"),
        ("readonly", struct.pack("<2f", 1.0, 0.0), True, "migration-required"),
    ):
        path = tmp_path / f"{label}.db"
        legacy_file(path, blob)
        connection = sqlite3.connect(
            f"file:{path}?mode=ro" if readonly else path, uri=readonly, isolation_level=None
        )
        try:
            with pytest.raises(SqliteAdapterError) as caught:
                ensure_registry(connection)
            assert caught.value.code == code
            assert connection.execute("SELECT value FROM _mirk_meta").fetchone()[0] == "2"
            assert connection.execute("SELECT vec FROM vectors").fetchone()[0] == blob
            assert (
                connection.execute(
                    "SELECT name FROM sqlite_master WHERE name='_mirk_vector_spaces'"
                ).fetchone()
                is None
            )
        finally:
            connection.close()


@pytest.mark.parametrize("driver", ["sqlite", "node-sqlite"])
@pytest.mark.parametrize("first", ["python", "typescript"])
def test_named_spaces_exchange_and_replace_in_both_directions(
    tmp_path: Path, driver: str, first: str
) -> None:
    path = tmp_path / "exchange.db"
    module = REPO / "packages/store/dist/adapters" / f"{driver}.js"
    adapter = "SqliteAdapter" if driver == "sqlite" else "NodeSqliteAdapter"
    setup = f"""
import {{ {adapter} }} from {json.dumps(str(module))};
const db = new {adapter}({{path:process.argv[2]}});
db.vector.ensureSpace('text',{{dimensions:2}});
db.vector.ensureSpace('image',{{dimensions:3}});
"""
    if first == "typescript":
        run_node_script(
            setup
            + """
db.vector.upsert('assets',{id:'a',vectors:{text:new Float32Array([1,0]),
 image:new Float32Array([0,1,0])},metadata:{origin:'typescript'}});
db.close();console.log(JSON.stringify({ok:true}));
""",
            tmp_path,
            str(path),
        )
    store = SqliteStore(str(path))
    try:
        vectors = SqliteVectorFacet(store.connection)
        vectors.ensureSpace("text", {"dimensions": 2})
        vectors.ensureSpace("image", {"dimensions": 3})
        if first == "typescript":
            doc = vectors.get("assets", "a")
            assert doc is not None and set(doc["vectors"]) == {"text", "image"}
            assert vectors.search("assets", {"space": "image", "vector": [0.0, 1.0, 0.0]})
        vectors.upsert(
            "assets", {"id": "a", "vectors": {"text": [0.0, 1.0]}, "metadata": {"origin": "python"}}
        )
    finally:
        store.close()
    result = run_node_script(
        setup
        + """
const doc=db.vector.get('assets','a');
if(Object.keys(doc.vectors).join()!=='text'||doc.metadata.origin!=='python')throw Error('exchange');
db.vector.upsert('assets',{id:'a',vectors:{image:new Float32Array([1,0,0])}});
db.close();console.log(JSON.stringify({ok:true}));
""",
        tmp_path,
        str(path),
    )
    assert result == {"ok": True}
    store = SqliteStore(str(path))
    try:
        vectors = SqliteVectorFacet(store.connection)
        doc = vectors.get("assets", "a")
        assert doc == {"id": "a", "vectors": {"image": [1.0, 0.0, 0.0]}}
        assert vectors.search("assets", {"space": "text", "vector": [1.0, 0.0]}) == []
        assert vectors.remove("assets", "a")
        assert vectors.count("assets") == 0
    finally:
        store.close()


def test_python_late_migration_failure_rolls_back_copies_and_drops(tmp_path: Path) -> None:
    path = tmp_path / "late-failure.db"
    blob = struct.pack("<2f", 1.0, 0.0)
    legacy_file(path, blob)
    connection = sqlite3.connect(path, isolation_level=None)
    connection.execute("""CREATE TRIGGER fail_version BEFORE UPDATE ON _mirk_meta
        BEGIN SELECT RAISE(ABORT,'injected migration failure'); END""")
    try:
        with pytest.raises(sqlite3.IntegrityError, match="injected migration failure"):
            ensure_registry(connection)
        assert connection.execute("SELECT value FROM _mirk_meta").fetchone()[0] == "2"
        assert connection.execute("SELECT vec FROM vectors").fetchone()[0] == blob
        assert (
            connection.execute(
                "SELECT name FROM sqlite_master WHERE name='_mirk_vector_values'"
            ).fetchone()
            is None
        )
    finally:
        connection.close()


def test_vector_facet_rejects_foreign_tasks_during_writer_transaction() -> None:
    import asyncio

    from mirk.store.transaction import SqliteTransactions

    async def run() -> None:
        store = SqliteStore(":memory:")
        vectors = SqliteVectorFacet(store.connection)
        vectors.ensureSpace("text", {"dimensions": 2})
        transactions = SqliteTransactions(store)
        entered = asyncio.Event()
        release = asyncio.Event()

        async def owner() -> None:
            async with transactions.transaction():
                vectors.upsert("assets", {"id": "a", "vectors": {"text": [1.0, 0.0]}})
                entered.set()
                await release.wait()

        task = asyncio.create_task(owner())
        await entered.wait()
        try:
            with pytest.raises(RuntimeError):
                vectors.upsert("assets", {"id": "b", "vectors": {"text": [0.0, 1.0]}})
            with pytest.raises(RuntimeError):
                vectors.get("assets", "a")
        finally:
            release.set()
            await task
        assert vectors.count("assets") == 1
        store.close()

    asyncio.run(run())


@pytest.mark.parametrize("driver", ["sqlite", "node-sqlite"])
def test_node_migrates_python_legacy_vectors(tmp_path: Path, driver: str) -> None:
    path = tmp_path / "python-v2.db"
    legacy_file(path, struct.pack("<2f", 1.0, 0.0))
    module = REPO / "packages/store/dist/adapters" / f"{driver}.js"
    adapter = "SqliteAdapter" if driver == "sqlite" else "NodeSqliteAdapter"
    result = run_node_script(
        f"""
import {{ {adapter} }} from {json.dumps(str(module))};
const db=new {adapter}({{path:process.argv[2]}});
const doc=db.vector.get('docs','a');
const vector=Array.from(doc.vectors.default);
db.close();console.log(JSON.stringify({{vector}}));
""",
        tmp_path,
        str(path),
    )
    assert result == {"vector": [1, 0]}
    store = SqliteStore(str(path))
    try:
        assert SqliteVectorFacet(store.connection).listSpaces()[0]["dimensions"] == 2
    finally:
        store.close()


def test_python_migrates_node_legacy_vectors(tmp_path: Path) -> None:
    path = tmp_path / "node-v2.db"
    run_node_script(
        """
import {DatabaseSync} from 'node:sqlite';
const db=new DatabaseSync(process.argv[2]);
db.exec(`CREATE TABLE _mirk_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
INSERT INTO _mirk_meta VALUES('schema_version','2');
CREATE TABLE _mirk_tables(kind TEXT,name TEXT,table_name TEXT UNIQUE,PRIMARY KEY(kind,name));
CREATE TABLE vectors(collection TEXT,id TEXT,vec BLOB,metadata TEXT,PRIMARY KEY(collection,id));
CREATE TABLE _vec_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
INSERT INTO _vec_meta VALUES('dimensions','2');`);
db.prepare('INSERT INTO vectors VALUES(?,?,?,?)').run('docs','a',
 Buffer.from('0000803f00000000','hex'), '{}');db.close();
console.log(JSON.stringify({ok:true}));
""",
        tmp_path,
        str(path),
    )
    store = SqliteStore(str(path))
    try:
        assert SqliteVectorFacet(store.connection).get("docs", "a") == {
            "id": "a",
            "vectors": {"default": [1.0, 0.0]},
            "metadata": {},
        }
    finally:
        store.close()
