"""Prepare one checksum-verified source payload for either package system."""

import hashlib
import json
from pathlib import Path
import re
import shutil
import sys


def prepare(destination: Path) -> None:
    source = Path(__file__).parent
    manifest = json.loads((source / "provenance.json").read_text(encoding="utf-8"))
    for name, checksum in manifest["files"].items():
        if hashlib.sha256((source / name).read_bytes()).hexdigest() != checksum:
            raise RuntimeError(f"Native source checksum mismatch: {name}")
    original = (source / "sqlite-vec.c").read_text(encoding="utf-8").splitlines(keepends=True)
    changes = (source / "f64.patch").read_text(encoding="utf-8").splitlines(keepends=True)
    output: list[str] = []
    cursor = 0
    for line in changes[2:]:
        if line.startswith("@@"):
            match = re.match(r"@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@", line)
            if match is None:
                raise RuntimeError("Malformed native patch")
            position = int(match[1]) - 1
            output.extend(original[cursor:position])
            cursor = position
        elif line.startswith((" ", "-")):
            if original[cursor] != line[1:]:
                raise RuntimeError("Native patch context mismatch")
            if line[0] == " ":
                output.append(original[cursor])
            cursor += 1
        elif line.startswith("+"):
            output.append(line[1:])
        else:
            raise RuntimeError("Unexpected native patch line")
    output.extend(original[cursor:])
    patched = "".join(output).encode()
    if hashlib.sha256(patched).hexdigest() != manifest["patched_sha256"]:
        raise RuntimeError("Patched native source checksum mismatch")
    destination.mkdir(parents=True, exist_ok=True)
    for name in [*manifest["files"], "provenance.json"]:
        if name != "sqlite-vec.c":
            shutil.copyfile(source / name, destination / name)
    (destination / "sqlite-vec.c").write_bytes(patched)


if __name__ == "__main__":
    prepare(Path(sys.argv[1]))
