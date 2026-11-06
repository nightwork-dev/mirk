#!/usr/bin/env python3
"""Explicitly generate immutable format fixtures into a new directory."""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import sqlite3
import struct
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCHEMAS = ROOT / "testdata/sqlite-format/schemas"
PROVENANCE = {
    "legacy": "5aa4088e536e5d525632fd1d5b0a946652b058f9",
    "v2-early": "36f0c9b8210026a990a48ec04800d593b9e1f1ca",
    "v2": "e746b39269b85e905611377391f94601d20a0e9c",
    "v3": "ddeeac88663eda7b54e9bfb7c38ccbb3251ab81f",
    "v4": "441f6ff271a01b70d2ce90b039ad885611f5ec7a",
}
STAMP = "2026-11-06 00:00:00"
UNICODE = {"text": "café 雪 🌱", "lone": "\ud800", "n": 9007199254740991, "fraction": 0.125, "boolean": True, "null": None}


def encoded(value: object) -> str:
    return json.dumps(value, ensure_ascii=True, separators=(",", ":"))


def hash_name(value: str) -> str:
    h = 2166136261
    for index in range(0, len(raw := value.encode("utf-16-le")), 2):
        h = ((h ^ int.from_bytes(raw[index:index + 2], "little")) * 16777619) & 0xffffffff
    out = ""
    while h:
        h, digit = divmod(h, 36)
        out = "0123456789abcdefghijklmnopqrstuvwxyz"[digit] + out
    return out or "0"


def populate(db: sqlite3.Connection, name: str) -> None:
    version = None if name == "legacy" else int(name[1])
    if version is not None:
        db.execute("INSERT INTO _mirk_meta VALUES('schema_version',?)", (str(version),))
    db.execute("INSERT INTO _kv VALUES(?,?,?,?)", ("unicode", encoded(UNICODE), STAMP, STAMP))
    db.execute("INSERT INTO _mirk_atomic_identity VALUES(1,'golden-store')")
    db.execute("INSERT INTO _mirk_atomic_sequence VALUES(1,7)")
    db.execute("INSERT INTO _mirk_atomic_versions VALUES('key','','unicode','golden-store-v7')")
    request = {"schema": "mirk-atomic-request/v1", "conditions": [], "operations": [{"op": "set", "key": "receipt-demo", "value": {"demo": True}}], "outcome": {"copied": True}}
    request_digest = hashlib.sha256(json.dumps(request, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    db.execute("INSERT INTO _kv VALUES('receipt-demo',?,?,?)", (encoded({"demo": True}), STAMP, STAMP))
    db.execute("INSERT INTO _mirk_atomic_versions VALUES('key','','receipt-demo','golden-store-v6')")
    result = {"status": "applied", "requestDigest": request_digest, "versions": [{"target": {"kind": "key", "key": "receipt-demo"}, "version": "golden-store-v6"}], "outcome": {"copied": True}}
    receipt = ("golden-command", request_digest, encoded(result))
    if name in ("v2", "v3", "v4"):
        db.execute("INSERT INTO _mirk_atomic_receipts VALUES(?,?,?,?)", (*receipt, 1793923200000))
    else:
        db.execute("INSERT INTO _mirk_atomic_receipts VALUES(?,?,?)", receipt)
    collection = "c_items_" + hash_name("items")
    db.execute(f"CREATE TABLE {collection}(id TEXT PRIMARY KEY,data JSON NOT NULL,created_at TEXT DEFAULT(datetime('now')),updated_at TEXT DEFAULT(datetime('now')))")
    for identifier, rank in (("b", 2), ("a", 1)):
        db.execute(f"INSERT INTO {collection} VALUES(?,?,?,?)", (identifier, encoded({"id": identifier, "rank": rank}), STAMP, STAMP))
    if version is not None:
        db.execute("INSERT INTO _mirk_tables VALUES('collection','items',?)", (collection,))
    if name in ("v2", "v3", "v4"):
        db.execute(f'''CREATE INDEX ix_{collection}_72616e6b ON {collection}(json_extract(data,'$."rank"'))''')
    docs = "search_docs_notes_" + hash_name("notes")
    fts = docs.replace("search_docs_", "search_fts_", 1)
    db.execute("INSERT INTO _mirk_search_schema VALUES('notes','[\"text\"]')")
    if version is not None:
        db.execute("INSERT INTO _mirk_tables VALUES('search','notes',?)", (docs,))
    db.executescript(f'''CREATE TABLE {docs}(id TEXT PRIMARY KEY,text TEXT NOT NULL,meta_json TEXT);
CREATE VIRTUAL TABLE {fts} USING fts5(text,content='{docs}',content_rowid='rowid',tokenize='unicode61');
CREATE TRIGGER {docs}_ai AFTER INSERT ON {docs} BEGIN INSERT INTO {fts}(rowid,text) VALUES(new.rowid,new.text); END;
CREATE TRIGGER {docs}_ad AFTER DELETE ON {docs} BEGIN INSERT INTO {fts}({fts},rowid,text) VALUES('delete',old.rowid,old.text); END;
CREATE TRIGGER {docs}_au AFTER UPDATE ON {docs} BEGIN INSERT INTO {fts}({fts},rowid,text) VALUES('delete',old.rowid,old.text); INSERT INTO {fts}(rowid,text) VALUES(new.rowid,new.text); END;''')
    db.execute(f"INSERT INTO {docs} VALUES('note','café golden search',NULL)")
    vectors = [("a", [1.0, -2.0, 0.5], None), ("b", [0.0, 1.0, 0.0], "{}"), ("雪", [-1.0, 0.0, 1.0], encoded({"label": "café 🌱"}))]
    if version is None or version == 2:
        db.execute("INSERT INTO _vec_meta VALUES('dimensions','3')")
        for identifier, values, metadata in vectors:
            db.execute("INSERT INTO vectors VALUES('assets',?,?,?)", (identifier, struct.pack("<3f", *values), metadata))
    else:
        db.executemany("INSERT INTO _mirk_vector_spaces VALUES(?,?,?,'cosine','float32')", [("default", "text", 3), ("default", "image", 2), ("other", "text", 4)])
        for identifier, values, metadata in vectors:
            db.execute("INSERT INTO _mirk_vector_documents VALUES('default','assets',?,?)", (identifier, metadata))
            db.execute("INSERT INTO _mirk_vector_values VALUES('default','assets',?,'text',?)", (identifier, struct.pack("<3f", *values)))
        db.execute("INSERT INTO _mirk_vector_values VALUES('default','assets','a','image',?)", (struct.pack("<2f", 0.25, 0.75),))
        db.execute("INSERT INTO _mirk_vector_documents VALUES('other','assets','a',NULL)")
        db.execute("INSERT INTO _mirk_vector_values VALUES('other','assets','a','text',?)", (struct.pack("<4f", 1, 0, 0, 0),))
    if name in ("v2", "v3", "v4"):
        db.executemany("INSERT INTO _mirk_log VALUES('asset/a',?,?)", [(1, encoded({"type": "created"})), (2, encoded({"type": "ready", "text": "雪"}))])
    if version == 4:
        db.execute("INSERT INTO _mirk_log_generation VALUES(1,8)")
        db.execute("INSERT INTO _mirk_log_streams VALUES('asset/a',8)")
    db.execute("CREATE TABLE application_owned(id INTEGER PRIMARY KEY,note TEXT)")
    db.execute("INSERT INTO application_owned VALUES(1,'preserved')")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", required=True, type=Path, help="New output directory; existing files are never overwritten")
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    if any(args.out.iterdir()):
        parser.error("output directory must be empty")
    manifest: dict[str, object] = {"generator": "scripts/generate-sqlite-format-goldens.py", "sqliteVersion": sqlite3.sqlite_version, "files": []}
    inspector_spec = importlib.util.spec_from_file_location("golden_inspector", ROOT / "scripts/sqlite-format/inspect.py")
    assert inspector_spec and inspector_spec.loader
    inspector = importlib.util.module_from_spec(inspector_spec)
    inspector_spec.loader.exec_module(inspector)
    files: list[dict[str, object]] = []
    for name, revision in PROVENANCE.items():
        path = args.out / (name + ".sqlite")
        schema = (SCHEMAS / (name + ".sql")).read_text()
        db = sqlite3.connect(path)
        try:
            db.executescript("PRAGMA page_size=4096;PRAGMA journal_mode=DELETE;PRAGMA foreign_keys=ON;" + schema)
            populate(db, name)
            db.commit()
            assert db.execute("PRAGMA integrity_check").fetchone() == ("ok",)
            assert db.execute("PRAGMA foreign_key_check").fetchall() == []
        finally:
            db.close()
        files.append({"file": path.name, "coreVersion": None if name == "legacy" else int(name[1]), "sha256": hashlib.sha256(path.read_bytes()).hexdigest(), "schemaSha256": hashlib.sha256(schema.encode()).hexdigest(), "sourceRevision": revision, "logical": inspector.inspect(path)})
    manifest["files"] = files
    manifest["expected"] = {"unicode": UNICODE, "collectionOrder": ["b", "a"], "knownVectorHex": "0000803f000000c00000003f", "knownVector": [1.0, -2.0, 0.5], "atomicIdentity": "golden-store", "atomicSequence": 7, "atomicVersion": "golden-store-v7"}
    (args.out / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=True, indent=2) + "\n")


if __name__ == "__main__":
    main()
