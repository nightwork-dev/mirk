"""The in-memory fixture source: fully deterministic, no I/O, no OS.

This is the source the shared conformance corpus is built on. Everything it
does is expressible as JSON, so a scenario declares its files inline.
"""

from __future__ import annotations

import re

from ..errors import FixtureError
from ..types import FixtureSourceEntry

__all__ = ["MemoryFixtureSource", "create_memory_fixture_source"]

_LEADING_DOT_SLASH = re.compile(r"^\./")


class MemoryFixtureSource:
    """Files held in a dict, keyed by normalized relative path."""

    def __init__(self, id: str, files: dict[str, str]) -> None:
        self.id = id
        self._files: dict[str, str] = {
            _normalize_path(path): content for path, content in files.items()
        }

    def list(self) -> list[FixtureSourceEntry]:
        """Entries in code point order. The locator is the path itself."""
        return [{"relativePath": path, "locator": path} for path in sorted(self._files)]

    def read(self, entry: FixtureSourceEntry) -> str:
        content = self._files.get(entry["locator"])
        if content is None:
            raise FixtureError(
                {
                    "severity": "error",
                    "code": "source-read-failed",
                    "message": (
                        f'Memory source "{self.id}" has no entry "{entry["relativePath"]}".'
                    ),
                    "source": self.id,
                    "path": entry["relativePath"],
                }
            )
        return content


def create_memory_fixture_source(id: str, files: dict[str, str]) -> MemoryFixtureSource:
    return MemoryFixtureSource(id, files)


def _normalize_path(path: str) -> str:
    """Backslashes become forward slashes; one leading `./` is stripped."""
    return _LEADING_DOT_SLASH.sub("", path.replace("\\", "/"), count=1)
