"""Loadable extension path; importing this module never compiles native code."""

import sys
from pathlib import Path


class NativeCompanionUnavailableError(RuntimeError):
    code = "native-companion-unavailable"


def loadable_path() -> str:
    path = Path(__file__).parent / ("vec0.dll" if sys.platform == "win32" else "vec0.so")
    if not path.is_file():
        raise NativeCompanionUnavailableError(
            "Mirk sqlite-vec native binary is missing; reinstall the optional companion"
        )
    return str(path)
