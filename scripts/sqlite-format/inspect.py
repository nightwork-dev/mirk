"""Read a format golden without opening a Mirk adapter or migrating it."""
from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from urllib.parse import quote


def inspect(path: Path) -> dict[str, object]:
    db = sqlite3.connect("file:" + quote(str(path.resolve())) + "?mode=ro&immutable=1", uri=True)
    db.row_factory = sqlite3.Row
    try:
        tables = {row["name"] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        def rows(sql: str) -> list[dict[str, object]]:
            return [dict(row) for row in db.execute(sql)]
        version = None
        if "_mirk_meta" in tables:
            markers = db.execute("SELECT value FROM _mirk_meta WHERE key='schema_version'").fetchall()
            if len(markers) != 1 or markers[0][0] not in ("2", "3", "4"):
                raise ValueError("Unsupported or malformed core format")
            version = int(markers[0][0])
        registry = rows("SELECT * FROM _mirk_tables ORDER BY kind,name") if "_mirk_tables" in tables else []
        collection = next((str(row["table_name"]) for row in registry if row["kind"] == "collection" and row["name"] == "items"), next(table for table in tables if table.startswith("c_items_")))
        docs = next((str(row["table_name"]) for row in registry if row["kind"] == "search" and row["name"] == "notes"), next(table for table in tables if table.startswith("search_docs_notes_")))
        fts = docs.replace("search_docs_", "search_fts_", 1)
        raw = db.execute("SELECT value FROM _kv WHERE key='unicode'").fetchone()[0]
        if version in (3, 4):
            vectors = rows("SELECT namespace,collection,id,space,lower(hex(vec)) AS hex FROM _mirk_vector_values ORDER BY namespace,collection,id,space")
            spaces = rows("SELECT * FROM _mirk_vector_spaces ORDER BY namespace,name")
        else:
            vectors = rows("SELECT 'default' AS namespace,collection,id,'default' AS space,lower(hex(vec)) AS hex FROM vectors ORDER BY collection,id")
            spaces = [{"namespace": "default", "name": "default", "dimensions": int(db.execute("SELECT value FROM _vec_meta WHERE key='dimensions'").fetchone()[0]), "metric": "cosine", "encoding": "float32"}]
        metadata_table = "_mirk_vector_documents" if version in (3, 4) else "vectors"
        namespace_column = "namespace" if version in (3, 4) else "'default'"
        vector_metadata = rows(f"SELECT {namespace_column} AS namespace,collection,id,metadata FROM {metadata_table} ORDER BY namespace,collection,id")
        receipt_columns = {row["name"] for row in db.execute("PRAGMA table_info(_mirk_atomic_receipts)")}
        receipts = rows("SELECT * FROM _mirk_atomic_receipts ORDER BY idempotency_key")
        for receipt in receipts:
            receipt.setdefault("created_at", None)
            receipt["result_json"] = json.loads(str(receipt["result_json"]))
        return {
            "version": version, "unicode": json.loads(raw), "unicodeRawHex": raw.encode().hex(),
            "kvRows": [{**row, "value": json.loads(str(row["value"]))} for row in rows("SELECT * FROM _kv ORDER BY key")],
            "registry": registry, "collectionRows": [json.loads(str(row["data"])) for row in rows(f"SELECT data FROM {collection} ORDER BY rowid")],
            "spaces": spaces, "vectors": vectors, "vectorMetadata": vector_metadata,
            "logs": rows("SELECT * FROM _mirk_log ORDER BY stream,sequence") if "_mirk_log" in tables else [],
            "logStreams": rows("SELECT * FROM _mirk_log_streams ORDER BY stream") if "_mirk_log_streams" in tables else [],
            "logGeneration": rows("SELECT * FROM _mirk_log_generation") if "_mirk_log_generation" in tables else [],
            "atomicIdentity": db.execute("SELECT value FROM _mirk_atomic_identity WHERE id=1").fetchone()[0],
            "atomicSequence": db.execute("SELECT value FROM _mirk_atomic_sequence WHERE id=1").fetchone()[0],
            "versions": rows("SELECT * FROM _mirk_atomic_versions ORDER BY kind,collection,target_key"),
            "receipts": receipts, "hasReceiptTime": "created_at" in receipt_columns,
            "searchDocuments": rows(f"SELECT * FROM {docs} ORDER BY rowid"),
            "searchMatches": [row[0] for row in db.execute(f"SELECT d.id FROM {fts} f JOIN {docs} d ON d.rowid=f.rowid WHERE {fts} MATCH 'golden' ORDER BY d.id")],
            "applicationRows": rows("SELECT * FROM application_owned ORDER BY id"),
            "declaredIndexes": rows("SELECT name,sql FROM sqlite_master WHERE type='index' AND name LIKE 'ix_%' ORDER BY name"),
        }
    finally:
        db.close()


if __name__ == "__main__":
    import sys
    print(json.dumps(inspect(Path(sys.argv[1])), ensure_ascii=True, sort_keys=True))
