"""Fixture documents held in a Mirk store, and the sink that seeds one.

The store dependency is structural, not a package import: this module needs
`list(collection)` and `getById(collection, id)`, plus `put` for seeding, and
nothing else. `mirk-store` never appears in an import here, exactly as
`@mirk/store` is only a devDependency of `@mirk/fixtures`.
"""

from __future__ import annotations

import re
from typing import Any, Protocol, runtime_checkable

from ..errors import FixtureError
from ..types import FixtureSourceEntry, LoadedFixture

__all__ = [
    "KvLike",
    "StoreFixtureSource",
    "WritableKvLike",
    "create_store_fixture_source",
    "seed_store_from_fixtures",
]

_LEADING_DOT_SLASH = re.compile(r"^\./")
_LEADING_SLASHES = re.compile(r"^/+")
# `\Z`, not `$`: Python's `$` also matches before a trailing newline.
_TRAILING_SLASHES = re.compile(r"/+\Z")
_DRIVE_PREFIX = re.compile(r"^[A-Za-z]:")


@runtime_checkable
class KvLike(Protocol):
    """The two read methods a store source needs."""

    def list(self, collection: str) -> Any: ...

    def getById(self, collection: str, id: str) -> Any: ...


@runtime_checkable
class WritableKvLike(KvLike, Protocol):
    def put(self, collection: str, item: Any) -> Any: ...


class StoreFixtureSource:
    """Rows of a collection presented as fixture documents.

    A row is `{id, content, extension, relativePath?, updatedAt?, meta?}`;
    `updatedAt` and `meta` are carried and never read. The mapped rows are
    cached until `invalidate()`, so a row added later is invisible until then.
    """

    def __init__(
        self,
        id: str,
        store: KvLike,
        collection: str,
        path_prefix: str | None = None,
        map_item: Any = None,
    ) -> None:
        self.id = id
        self._store = store
        self._collection = collection
        self._path_prefix = path_prefix
        self._map_item = map_item
        self._cache: list[dict[str, Any]] | None = None
        self._item_by_locator: dict[str, dict[str, Any]] = {}

    def _load_items(self) -> list[dict[str, Any]]:
        if self._cache is not None:
            return self._cache
        raw: list[Any] = list(self._store.list(self._collection))
        mapped: list[dict[str, Any]] = [
            self._map_item(item) if self._map_item else item for item in raw
        ]

        seen_paths: set[str] = set()
        next_by_locator: dict[str, dict[str, Any]] = {}
        for item in mapped:
            relative_path = _relative_path_for(item, self._path_prefix)
            if relative_path in seen_paths:
                raise FixtureError(
                    {
                        "severity": "error",
                        "code": "duplicate-relative-path",
                        "message": (
                            f'Store source "{self.id}" produced duplicate relative path '
                            f'"{relative_path}".'
                        ),
                        "source": self.id,
                        "path": relative_path,
                    }
                )
            seen_paths.add(relative_path)
            next_by_locator[str(item["id"])] = item

        self._cache = sorted(
            mapped,
            key=lambda item: (_relative_path_for(item, self._path_prefix), str(item["id"])),
        )
        self._item_by_locator = next_by_locator
        return self._cache

    def list(self) -> list[FixtureSourceEntry]:
        """Entries sorted by relative path, then by id, in code point order."""
        return [
            {
                "relativePath": _relative_path_for(item, self._path_prefix),
                "locator": str(item["id"]),
            }
            for item in self._load_items()
        ]

    def read(self, entry: FixtureSourceEntry) -> str:
        self._load_items()
        item = self._item_by_locator.get(entry["locator"])
        if item is None or _relative_path_for(item, self._path_prefix) != entry["relativePath"]:
            raise FixtureError(
                {
                    "severity": "error",
                    "code": "source-read-failed",
                    "message": (
                        f'Store source "{self.id}" has no listed entry "{entry["relativePath"]}".'
                    ),
                    "source": self.id,
                    "path": entry["relativePath"],
                }
            )
        return str(item["content"])

    def invalidate(self) -> None:
        """The loader never calls this. A consumer invalidates both."""
        self._cache = None
        self._item_by_locator = {}


def create_store_fixture_source(
    id: str,
    store: KvLike,
    collection: str,
    path_prefix: str | None = None,
    map_item: Any = None,
) -> StoreFixtureSource:
    return StoreFixtureSource(id, store, collection, path_prefix, map_item)


def seed_store_from_fixtures(
    loader: Any,
    store: WritableKvLike,
    targets: dict[str, str],
    mode: str = "upsert",
    include_provenance: bool = False,
    validate_before_write: bool = True,
    map_item: Any = None,
) -> dict[str, list[dict[str, Any]]]:
    """Write every fixture of each target type into its collection.

    Collection happens fully before any write, so a validation or load failure
    anywhere leaves the store untouched — including fixtures of an earlier
    target type that were themselves valid.
    """
    pending: list[dict[str, Any]] = []

    for type_name, collection in targets.items():
        for ref in loader.list(type_name):
            if validate_before_write:
                report = loader.validate(ref)
                if not report["ok"]:
                    raise FixtureError(
                        {
                            "severity": "error",
                            "code": "seed-validation-failed",
                            "message": (f'Fixture "{ref}" failed validation before store seeding.'),
                            "fixture": ref,
                        }
                    )
            fixture: LoadedFixture = loader.loadRaw(ref)
            item = (
                map_item(fixture) if map_item else _default_seed_item(fixture, include_provenance)
            )
            pending.append(
                {"type": type_name, "collection": collection, "fixture": fixture, "item": item}
            )

    written: list[dict[str, Any]] = []
    skipped: list[dict[str, Any]] = []

    for entry in pending:
        item: dict[str, Any] = entry["item"]
        if mode == "insert-only":
            existing = store.getById(entry["collection"], str(item["id"]))
            if existing:
                skipped.append(
                    {
                        "type": entry["type"],
                        "ref": entry["fixture"]["ref"],
                        "collection": entry["collection"],
                        "id": item["id"],
                        "reason": "exists",
                    }
                )
                continue

        store.put(entry["collection"], item)
        written.append(
            {
                "type": entry["type"],
                "ref": entry["fixture"]["ref"],
                "collection": entry["collection"],
                "id": item["id"],
            }
        )

    return {"written": written, "skipped": skipped}


def _default_seed_item(fixture: LoadedFixture, include_provenance: bool) -> dict[str, Any]:
    item: dict[str, Any] = {"id": fixture["id"], "value": fixture["value"]}
    if include_provenance:
        item["provenance"] = fixture["provenance"]
    return item


def _relative_path_for(item: dict[str, Any], path_prefix: str | None) -> str:
    """An explicit `relativePath` is used as-is and the prefix is NOT applied."""
    explicit = item.get("relativePath")
    if explicit:
        return _normalize_public_path(str(explicit), "relativePath")
    tail = _normalize_public_path(f"{item['id']}{item.get('extension', '')}", "relativePath")
    if not path_prefix:
        return tail
    return f"{_normalize_public_path(path_prefix, 'pathPrefix')}/{tail}"


def _normalize_public_path(value: str, field: str) -> str:
    normalized = _TRAILING_SLASHES.sub(
        "", _LEADING_SLASHES.sub("", _LEADING_DOT_SLASH.sub("", value, count=1))
    )
    parts = normalized.split("/")
    if (
        normalized == ""
        or "\\" in value
        or value.startswith("/")
        or _DRIVE_PREFIX.match(value)
        or any(part in ("", ".", "..") for part in parts)
    ):
        raise FixtureError(
            {
                "severity": "error",
                "code": "unsafe-relative-path",
                "message": (f'Store fixture {field} "{value}" is not a safe source-relative path.'),
                "path": value,
            }
        )
    return normalized
