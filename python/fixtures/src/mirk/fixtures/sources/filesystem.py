"""Fixture documents on disk.

The rules port; the Node code does not. Every discovered path is resolved to
its real path and asserted to be inside the real root, symlinked directories
are not descended into, and listing order is Unicode code point order rather
than the locale collation the TypeScript source used.
"""

from __future__ import annotations

import os
import re
from pathlib import Path
from typing import NamedTuple

from ..errors import FixtureError
from ..types import FixtureSourceEntry

__all__ = ["FilesystemFixtureSource", "create_filesystem_fixture_source"]

_DRIVE_PREFIX = re.compile(r"^[A-Za-z]:")


class _ListedFile(NamedTuple):
    relativePath: str
    realPath: str


class FilesystemFixtureSource:
    """A directory tree, listed depth-first in code point order.

    Locators are positional (`entry:<index>`) and `list()` replaces the map, so
    an entry object from an earlier listing can be stale. The `relativePath`
    cross-check on `read` is what makes that fail closed instead of silently
    reading a different file.
    """

    def __init__(self, id: str, root: str | os.PathLike[str]) -> None:
        self.id = id
        self._root = _resolve_root(id, root)
        self._listed: dict[str, _ListedFile] = {}

    def list(self) -> list[FixtureSourceEntry]:
        files = _walk(self._root, self.id)
        self._listed = {f"entry:{index}": file for index, file in enumerate(files)}
        return [
            {"relativePath": file.relativePath, "locator": locator}
            for locator, file in self._listed.items()
        ]

    def read(self, entry: FixtureSourceEntry) -> str:
        file = self._listed.get(entry["locator"])
        if file is None or file.relativePath != entry["relativePath"]:
            raise _source_error(self.id, entry["relativePath"], "has no listed entry")

        current = _resolve_listed_file(self._root, file.relativePath, self.id)
        if current != file.realPath:
            raise _source_error(self.id, file.relativePath, "entry changed after it was listed")

        try:
            return Path(current).read_text(encoding="utf-8")
        except OSError as error:
            raise _source_error(self.id, file.relativePath, "could not read entry") from error


def create_filesystem_fixture_source(
    id: str, root: str | os.PathLike[str]
) -> FilesystemFixtureSource:
    return FilesystemFixtureSource(id, root)


def _resolve_root(source_id: str, root: str | os.PathLike[str]) -> str:
    """Resolve and validate the root. The message omits the path on purpose."""
    try:
        resolved = os.path.realpath(os.path.abspath(str(root)))
        if not os.path.isdir(resolved):
            raise NotADirectoryError(resolved)
    except OSError as error:
        raise FixtureError(
            {
                "severity": "error",
                "code": "source-root-unavailable",
                "message": (
                    f'Filesystem source "{source_id}" root is unavailable or is not a directory.'
                ),
                "source": source_id,
            }
        ) from error
    return resolved


def _walk(root: str, source_id: str) -> list[_ListedFile]:
    files: list[_ListedFile] = []

    def visit(directory: str, prefix: str) -> None:
        try:
            names = sorted(os.listdir(directory))
        except OSError as error:
            raise _source_error(source_id, prefix or ".", "could not list directory") from error

        for name in names:
            relative_path = f"{prefix}/{name}" if prefix else name
            _assert_relative_path(relative_path, source_id)
            discovered = os.path.join(directory, name)
            is_symlink = os.path.islink(discovered)
            try:
                real_path = os.path.realpath(discovered)
                _assert_inside_root(root, real_path, source_id, relative_path)
                if not os.path.exists(real_path):
                    # A broken symlink: `realpathSync` throws in Node, so this
                    # must be an error here too rather than a silent skip.
                    raise FileNotFoundError(real_path)
                is_directory = os.path.isdir(real_path)
                is_file = os.path.isfile(real_path)
            except FixtureError:
                raise
            except OSError as error:
                raise _source_error(source_id, relative_path, "could not resolve entry") from error

            if is_directory:
                if not is_symlink:
                    visit(real_path, relative_path)
                continue
            if is_file:
                files.append(_ListedFile(relative_path, real_path))

    visit(root, "")
    return sorted(files, key=lambda file: file.relativePath)


def _resolve_listed_file(root: str, relative_path: str, source_id: str) -> str:
    _assert_relative_path(relative_path, source_id)
    try:
        real_path = os.path.realpath(os.path.join(root, *relative_path.split("/")))
        _assert_inside_root(root, real_path, source_id, relative_path)
        if not os.path.isfile(real_path):
            raise IsADirectoryError(real_path)
        return real_path
    except FixtureError:
        raise
    except OSError as error:
        raise _source_error(source_id, relative_path, "could not resolve entry") from error


def _assert_inside_root(root: str, candidate: str, source_id: str, relative_path: str) -> None:
    from_root = os.path.relpath(candidate, root)
    if from_root == ".." or from_root.startswith(f"..{os.sep}") or os.path.isabs(from_root):
        raise FixtureError(
            {
                "severity": "error",
                "code": "source-path-escape",
                "message": (
                    f'Filesystem source "{source_id}" entry "{relative_path}" resolves '
                    f"outside its root."
                ),
                "source": source_id,
                "path": relative_path,
            }
        )


def _assert_relative_path(path: str, source_id: str) -> None:
    parts = path.split("/")
    if (
        path == ""
        or "\\" in path
        or path.startswith("/")
        or _DRIVE_PREFIX.match(path)
        or any(part in ("", ".", "..") for part in parts)
    ):
        raise FixtureError(
            {
                "severity": "error",
                "code": "unsafe-relative-path",
                "message": (
                    f'Filesystem source "{source_id}" entry "{path}" is not a safe '
                    f"source-relative path."
                ),
                "source": source_id,
                "path": path,
            }
        )


def _source_error(source_id: str, path: str, action: str) -> FixtureError:
    return FixtureError(
        {
            "severity": "error",
            "code": "source-read-failed",
            "message": f'Filesystem source "{source_id}" {action} "{path}".',
            "source": source_id,
            "path": path,
        }
    )
