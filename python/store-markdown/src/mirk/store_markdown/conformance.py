"""JSON-safe target facade used by Mirk's generated conformance runner."""

from __future__ import annotations

import os
import re
import tempfile
from pathlib import Path
from typing import Any, cast

from mirk.store.types import StoreFilter

from .markdown_store import (
    MarkdownCollectionConfig,
    MarkdownStore,
    MarkdownStoreCorruptionError,
    MarkdownStoreError,
    _join_within,  # pyright: ignore[reportPrivateUsage]
)

__all__ = ["conformance_target"]


class _MarkdownTarget:
    def __init__(self, backend: str, connection: object) -> None:
        del backend, connection
        self._temporary = tempfile.TemporaryDirectory(prefix="mirk-markdown-conformance-")
        self._root = Path(self._temporary.name).resolve()
        self._store: MarkdownStore
        self.configure()

    def configure(self, spec: dict[str, Any] | None = None) -> None:
        spec = spec or {}
        # A scenario's configure step starts a fresh document tree.
        for child in self._root.iterdir():
            if child.is_dir():
                for path in sorted(child.rglob("*"), reverse=True):
                    if path.is_file() or path.is_symlink():
                        path.unlink()
                    elif path.is_dir():
                        path.rmdir()
                child.rmdir()
            else:
                child.unlink()
        collections: dict[str, MarkdownCollectionConfig] = cast(
            dict[str, MarkdownCollectionConfig], spec.get("collections") or {}
        )
        if spec.get("preset") == "notes":
            collections = {
                "documents": {
                    "directory": "docs",
                    "frontmatterFields": ["title", "status"],
                    "body": {
                        "preambleField": "summary",
                        "sections": {"details": {"heading": "Details"}},
                    },
                    "fileName": lambda item: f"{_slug(str(item['title']))}.md",
                    "index": {
                        "heading": "Notes",
                        "fileName": cast(str, spec.get("indexFileName", "INDEX.md")),
                        "renderLine": lambda item: (
                            f"- {_js_text(item.get('id'))} · {_js_text(item.get('title'))} · "
                            f"{_js_text(item.get('status'))}"
                        ),
                    },
                }
            }
        self._store = MarkdownStore(
            self._root,
            collections=collections,
            git=spec.get("git", False),
        )

    def set(self, key: str, value: Any) -> None:
        self._store.set(key, value)

    def get(self, key: str) -> Any:
        return self._store.get(key)

    def has(self, key: str) -> bool:
        return self._store.has(key)

    def delete(self, key: str) -> bool:
        return self._store.delete(key)

    def keys(self, prefix: str | None = None) -> list[str]:
        return self._store.keys(prefix)

    def list(self, collection: str, filter: dict[str, Any] | None = None) -> list[Any]:
        return self._store.list(collection, cast(StoreFilter | None, filter))

    def getById(self, collection: str, id: str) -> Any:
        return self._store.getById(collection, id)

    def put(self, collection: str, item: dict[str, Any]) -> dict[str, Any]:
        return self._store.put(collection, item)

    def remove(self, collection: str, id: str) -> bool:
        return self._store.remove(collection, id)

    def count(self, collection: str, filter: dict[str, Any] | None = None) -> int:
        return self._store.count(collection, cast(StoreFilter | None, filter))

    def writeFile(self, relative: str, contents: str) -> None:
        path = _join_within(self._root, relative)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(contents, encoding="utf-8")

    def readFile(self, relative: str) -> str | None:
        path = _join_within(self._root, relative)
        return path.read_text(encoding="utf-8") if path.exists() else None

    def fileContains(self, relative: str, text: str) -> bool:
        contents = self.readFile(relative)
        return contents is not None and text in contents

    def files(self) -> list[str]:
        result: list[str] = []
        for path in sorted(self._root.rglob("*.md")):
            if path.is_file():
                result.append(os.path.relpath(path, self._root))
        return result

    def failure(self, operation: str, args: list[Any]) -> dict[str, Any]:
        try:
            getattr(self, operation)(*args)
            return {"code": "none"}
        except MarkdownStoreCorruptionError as error:
            paths: list[str] = []
            for item in error.errors:
                match = re.search(r"(/[^:]+\.md):", str(item))
                if match:
                    paths.append(os.path.relpath(match.group(1), self._root))
            return {"code": "corrupt-records", "paths": sorted(paths)}
        except MarkdownStoreError as error:
            return {"code": error.code}
        raise AssertionError(f"expected an adapter failure: {operation}")

    def close(self) -> None:
        self._temporary.cleanup()

    dispose = close


def conformance_target(backend: str, connection: object) -> _MarkdownTarget:
    return _MarkdownTarget(backend, connection)


def _slug(value: str) -> str:
    return re.sub(r"^-|-+$", "", re.sub(r"[^a-z0-9]+", "-", value.lower()))


def _js_text(value: Any) -> str:
    return "undefined" if value is None else str(value)
