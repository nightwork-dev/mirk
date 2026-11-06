#!/usr/bin/env python3
"""Read checked-in files only; regeneration and Mirk adapter opens are forbidden here."""
from __future__ import annotations

import hashlib
import importlib.util
import json
import shutil
import sqlite3
import struct
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FIXTURES = ROOT / "testdata/sqlite-format"
MANIFEST = json.loads((FIXTURES / "manifest.json").read_text())
spec = importlib.util.spec_from_file_location("golden_inspector", ROOT / "scripts/sqlite-format/inspect.py")
assert spec and spec.loader
inspector = importlib.util.module_from_spec(spec)
spec.loader.exec_module(inspector)


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


class GoldenFiles(unittest.TestCase):
    def test_python_and_node_read_same_contents_without_changing_files(self) -> None:
        for item in MANIFEST["files"]:
            with self.subTest(file=item["file"]):
                path = FIXTURES / item["file"]
                before = digest(path)
                self.assertEqual(before, item["sha256"])
                self.assertEqual(digest(FIXTURES / "schemas" / item["file"].replace(".sqlite", ".sql")), item["schemaSha256"])
                report = inspector.inspect(path)
                node = subprocess.run(["node", str(ROOT / "scripts/sqlite-format/inspect.mjs"), str(path)], check=True, capture_output=True, text=True)
                self.assertEqual(json.loads(node.stdout), report)
                self.assertEqual(report, item["logical"])
                self.assertEqual(report["version"], item["coreVersion"])
                self.assertEqual(report["unicode"], MANIFEST["expected"]["unicode"])
                self.assertEqual([row["id"] for row in report["collectionRows"]], ["b", "a"])
                self.assertEqual(report["searchMatches"], ["note"])
                self.assertEqual(report["atomicIdentity"], "golden-store")
                self.assertEqual(report["atomicSequence"], 7)
                vector = next(row for row in report["vectors"] if row["namespace"] == "default" and row["id"] == "a" and row["space"] in ("default", "text"))
                self.assertEqual(vector["hex"], MANIFEST["expected"]["knownVectorHex"])
                self.assertEqual(list(struct.unpack("<3f", bytes.fromhex(vector["hex"]))), [1.0, -2.0, 0.5])
                metadata = report["vectorMetadata"]
                self.assertTrue(any(row["id"] == "a" and row["metadata"] is None for row in metadata))
                self.assertTrue(any(row["id"] == "b" and row["metadata"] == "{}" for row in metadata))
                self.assertEqual(digest(path), before)
                self.assertFalse(path.with_name(path.name + "-wal").exists())
                self.assertFalse(path.with_name(path.name + "-journal").exists())

    def test_readonly_connections_reject_writes_on_disposable_copies(self) -> None:
        for item in MANIFEST["files"]:
            original = FIXTURES / item["file"]
            with tempfile.TemporaryDirectory(prefix="mirk-golden-readonly-") as temporary:
                path = Path(temporary) / item["file"]
                shutil.copyfile(original, path)
                before = digest(path)
                db = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
                try:
                    with self.assertRaises(sqlite3.OperationalError):
                        db.execute("CREATE TABLE forbidden(value TEXT)")
                finally:
                    db.close()
                code = "import {DatabaseSync} from 'node:sqlite';const db=new DatabaseSync(process.argv[1],{readOnly:true});try{db.exec('CREATE TABLE forbidden(value TEXT)');process.exitCode=1}catch(e){if(!String(e).includes('readonly'))throw e}finally{db.close()}"
                subprocess.run(["node", "--input-type=module", "-e", code, str(path)], check=True, capture_output=True)
                self.assertEqual(digest(path), before)
                self.assertEqual(digest(original), item["sha256"])

    def test_rust_pinned_reader_accepts_two_and_refuses_newer(self) -> None:
        if shutil.which("rustc") is None:
            self.skipTest("rustc is unavailable; independent Rust reader proof did not run")
        with tempfile.TemporaryDirectory(prefix="mirk-rust-reader-") as temporary:
            reader = Path(temporary) / "reader"
            subprocess.run(["rustc", "--edition=2021", str(ROOT / "examples/sqlite-format-reader/reader.rs"), "-o", str(reader)], check=True)
            for item in MANIFEST["files"]:
                path = FIXTURES / item["file"]
                before = digest(path)
                result = subprocess.run([str(reader), str(path), "assets", "a", "unicode"], capture_output=True, text=True)
                if item["coreVersion"] == 2:
                    self.assertEqual(result.returncode, 0, result.stderr)
                    decoded = json.loads(result.stdout)
                    self.assertEqual(decoded["vector_f32_decimal"], ["1", "-2", "0.5"])
                    self.assertEqual(decoded["vector_le_hex"], MANIFEST["expected"]["knownVectorHex"])
                    self.assertEqual(decoded["raw_json_utf8_hex"], item["logical"]["unicodeRawHex"])
                    self.assertFalse(decoded["json_decoded"])
                else:
                    self.assertEqual(result.returncode, 2)
                    if item["coreVersion"] in (3, 4):
                        self.assertIn("unsupported core format", result.stderr)
                    self.assertEqual(result.stdout, "")
                self.assertEqual(digest(path), before)

    def test_generation_requires_an_explicit_empty_destination(self) -> None:
        with tempfile.TemporaryDirectory(prefix="mirk-golden-reproduce-") as temporary:
            target = Path(temporary) / "generated"
            subprocess.run(["python3", str(ROOT / "scripts/generate-sqlite-format-goldens.py"), "--out", str(target)], check=True)
            generated = json.loads((target / "manifest.json").read_text())
            for item in generated["files"]:
                original = next(row for row in MANIFEST["files"] if row["file"] == item["file"])
                self.assertEqual(item["logical"], original["logical"])
                if generated["sqliteVersion"] == MANIFEST["sqliteVersion"]:
                    self.assertEqual(item["sha256"], original["sha256"])
            result = subprocess.run(["python3", str(ROOT / "scripts/generate-sqlite-format-goldens.py"), "--out", str(target)], capture_output=True)
            self.assertNotEqual(result.returncode, 0)


if __name__ == "__main__":
    unittest.main()
