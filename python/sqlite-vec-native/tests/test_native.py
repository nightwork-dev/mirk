import sqlite3
import struct

from mirk_sqlite_vec_native import loadable_path


def test_loadable_binary_preserves_float64_cutoff() -> None:
    db = sqlite3.connect(":memory:")
    try:
        db.enable_load_extension(True)
        db.load_extension(loadable_path())
        db.enable_load_extension(False)
        near = struct.pack("<3f", 1, 0.0001, 0)
        perfect = struct.pack("<3f", 1, 0, 0)
        row = db.execute(
            "SELECT vec_cosine_similarity_f64(?,?),vec_version()", (near, perfect)
        ).fetchone()
        assert row[0] == 0.9999999950000003
        assert row[1] == "v0.1.6"
    finally:
        db.close()
