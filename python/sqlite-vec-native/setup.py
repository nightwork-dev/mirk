from __future__ import annotations

import hashlib
import json
import os
import runpy
import sys
from pathlib import Path

from setuptools import Extension, setup
from setuptools.command.build_ext import build_ext
from setuptools.command.sdist import sdist

ROOT = Path(__file__).parent
PAYLOAD = ROOT / "src" / "mirk_sqlite_vec_native" / "_native"
CANONICAL = ROOT.parent.parent / "native" / "sqlite-vec" / "prepare.py"


def prepare() -> None:
    if CANONICAL.is_file():
        runpy.run_path(str(CANONICAL))["prepare"](PAYLOAD)
    if not (PAYLOAD / "provenance.json").is_file():
        raise RuntimeError(
            "Mirk sqlite-vec source payload is missing from this source distribution"
        )
    manifest = json.loads((PAYLOAD / "provenance.json").read_text())
    checksums = {**manifest["files"], "sqlite-vec.c": manifest["patched_sha256"]}
    for name, checksum in checksums.items():
        if hashlib.sha256((PAYLOAD / name).read_bytes()).hexdigest() != checksum:
            raise RuntimeError(f"Mirk sqlite-vec source checksum mismatch: {name}")


class NativeBuild(build_ext):
    def get_ext_filename(self, fullname: str) -> str:
        return os.path.join(*fullname.split(".")) + (".dll" if sys.platform == "win32" else ".so")

    def build_extensions(self) -> None:
        prepare()
        flags = (
            ["/O2", "/fp:strict", "/std:c11"]
            if self.compiler.compiler_type == "msvc"
            else ["-O2", "-ffp-contract=off", "-fno-fast-math"]
        )
        for extension in self.extensions:
            extension.extra_compile_args = flags
        super().build_extensions()


class NativeSource(sdist):
    def run(self) -> None:
        prepare()
        super().run()


prepare()
setup(
    ext_modules=[
        Extension(
            "mirk_sqlite_vec_native.vec0",
            ["src/mirk_sqlite_vec_native/_native/sqlite-vec.c"],
            libraries=[] if sys.platform == "win32" else ["m"],
        )
    ],
    cmdclass={"build_ext": NativeBuild, "sdist": NativeSource},
)
