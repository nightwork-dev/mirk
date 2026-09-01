"""In-memory reference implementation of the Mirk store port."""

from __future__ import annotations

import json
from typing import Any, cast

from .filter import IN_SCALAR_MESSAGE, apply_filter, dumps_json, is_scalar, json_equal
from .types import JsonObject, StoreFilter, StoreMeta

__all__ = ["InMemoryStore", "copy_json"]

_MISSING = object()


def copy_json(value: Any) -> Any:
    """Deep copy through a JSON round trip. Rejects NaN and infinities.

    Encoding through `dumps_json` keeps both backends returning the same
    number type: an integral float comes back as an int here exactly as it
    does from a SQLite row a TypeScript writer produced.
    """
    return json.loads(dumps_json(value))


def _assert_collection(collection: str) -> None:
    if len(collection) == 0:
        raise ValueError("Invalid collection name")


class InMemoryStore:
    """Reference store. Insertion-ordered, copy on write and on read."""

    def __init__(self) -> None:
        self._meta = StoreMeta(backend="memory")
        self._kv: dict[str, Any] = {}
        self._collections: dict[str, dict[str, Any]] = {}

    @property
    def meta(self) -> StoreMeta:
        return self._meta

    # ── Key-value ────────────────────────────────────────────────────────
    def get(self, key: str) -> Any:
        if key not in self._kv:
            return None
        return copy_json(self._kv[key])

    def set(self, key: str, value: Any) -> None:
        self._kv[key] = copy_json(value)

    def has(self, key: str) -> bool:
        return key in self._kv

    def delete(self, key: str) -> bool:
        if key in self._kv:
            del self._kv[key]
            return True
        return False

    def keys(self, prefix: str | None = None) -> list[str]:
        ordered = sorted(self._kv.keys())
        if not prefix:
            return ordered
        return [key for key in ordered if key.startswith(prefix)]

    # ── Collections ──────────────────────────────────────────────────────
    def _collection(self, collection: str) -> dict[str, Any]:
        _assert_collection(collection)
        existing = self._collections.get(collection)
        if existing is None:
            existing = {}
            self._collections[collection] = existing
        return existing

    def list(self, collection: str, filter: StoreFilter | None = None) -> list[Any]:
        items = list(self._collection(collection).values())
        return [copy_json(item) for item in apply_filter(items, filter)]

    def getById(self, collection: str, id: str) -> Any:
        item = self._collection(collection).get(id, _MISSING)
        if item is _MISSING:
            return None
        return copy_json(item)

    def put(self, collection: str, item: JsonObject) -> JsonObject:
        col = self._collection(collection)
        item_id = item.get("id")
        if not isinstance(item_id, str):
            raise ValueError("Collection items must have a string id")
        col[item_id] = copy_json(item)
        return item

    def remove(self, collection: str, id: str) -> bool:
        col = self._collection(collection)
        if id in col:
            del col[id]
            return True
        return False

    def count(self, collection: str, filter: StoreFilter | None = None) -> int:
        items = list(self._collection(collection).values())
        where = filter.get("where") if filter else None
        narrowed: StoreFilter = {"where": where} if where else {}
        return len(apply_filter(items, narrowed))

    def listWhereIn(
        self,
        collection: str,
        field: str,
        values: list[Any],
        filter: StoreFilter | None = None,
    ) -> list[Any]:
        if len(values) == 0:
            return []
        for value in values:
            if not is_scalar(value):
                raise ValueError(IN_SCALAR_MESSAGE)
        items = list(self._collection(collection).values())
        matched = [item for item in items if _field_in(item, field, values)]
        return [copy_json(item) for item in apply_filter(matched, filter)]


def _field_in(item: Any, field: str, values: list[Any]) -> bool:
    if not isinstance(item, dict):
        return False
    record = cast(dict[str, Any], item)
    if field not in record:
        return False
    actual = record[field]
    return any(json_equal(actual, value) for value in values)
