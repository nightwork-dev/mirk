"""Namespace decorator: pure string prefixing over any store satisfying the port."""

from __future__ import annotations

from typing import Any

from .types import JsonObject, StoreFilter, StoreMeta, SyncStore

__all__ = ["SEPARATOR", "NamespacedStore", "namespace_store"]

SEPARATOR = "\u001f"


def _assert_namespace(namespace: str) -> None:
    if len(namespace) == 0 or SEPARATOR in namespace:
        raise ValueError("namespace must be non-empty and must not contain the unit separator")


class NamespacedStore:
    """Prefixes every KV key and every collection name. Item ids are untouched."""

    def __init__(self, store: SyncStore, namespace: str) -> None:
        _assert_namespace(namespace)
        self._store = store
        self._namespace = namespace
        self._prefix = f"{namespace}{SEPARATOR}"

    def _bind(self, value: str) -> str:
        return f"{self._prefix}{value}"

    @property
    def meta(self) -> StoreMeta:
        return self._store.meta

    def get(self, key: str) -> Any:
        return self._store.get(self._bind(key))

    def set(self, key: str, value: Any) -> None:
        self._store.set(self._bind(key), value)

    def has(self, key: str) -> bool:
        return self._store.has(self._bind(key))

    def delete(self, key: str) -> bool:
        return self._store.delete(self._bind(key))

    def keys(self, prefix: str | None = None) -> list[str]:
        stored = self._store.keys(self._bind(prefix or ""))
        return [key[len(self._prefix) :] for key in stored]

    def list(self, collection: str, filter: StoreFilter | None = None) -> list[Any]:
        return self._store.list(self._bind(collection), filter)

    def getById(self, collection: str, id: str) -> Any:
        return self._store.getById(self._bind(collection), id)

    def put(self, collection: str, item: JsonObject) -> JsonObject:
        return self._store.put(self._bind(collection), item)

    def remove(self, collection: str, id: str) -> bool:
        return self._store.remove(self._bind(collection), id)

    def count(self, collection: str, filter: StoreFilter | None = None) -> int:
        return self._store.count(self._bind(collection), filter)


def namespace_store(store: SyncStore, namespace: str) -> NamespacedStore:
    """Return a view of `store` where every key and collection name is prefixed."""
    return NamespacedStore(store, namespace)
