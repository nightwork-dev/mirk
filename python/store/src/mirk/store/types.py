"""Port definitions for the Mirk store.

Method names keep the TypeScript camelCase spelling (``getById``, ``listWhereIn``)
on purpose: the language-neutral conformance corpus names an operation with a
single ``op`` string, and identical spellings let both runners dispatch that
string directly onto the port object with no translation table.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal, Protocol, TypedDict, runtime_checkable

__all__ = [
    "Json",
    "JsonObject",
    "StoreFilter",
    "StoreMeta",
    "SyncStore",
    "SyncStoreInQuery",
]

Json = Any
"""Any JSON value: null, bool, int, float, str, list, or dict with string keys."""

JsonObject = dict[str, Any]


class StoreFilter(TypedDict, total=False):
    """Structured filter for collection queries.

    Keys use the TypeScript wire spelling so corpus arguments map straight in.
    """

    where: dict[str, Any]
    sortBy: str
    sortDir: Literal["asc", "desc"]
    limit: float
    offset: float


@dataclass(frozen=True, slots=True)
class StoreMeta:
    """Metadata about a store instance."""

    backend: str


@runtime_checkable
class SyncStore(Protocol):
    """A typed key-value plus collection store. Synchronous by design."""

    @property
    def meta(self) -> StoreMeta: ...

    # Key-value
    def get(self, key: str) -> Any: ...
    def set(self, key: str, value: Any) -> None: ...
    def has(self, key: str) -> bool: ...
    def delete(self, key: str) -> bool: ...
    def keys(self, prefix: str | None = None) -> list[str]: ...

    # Collections
    def list(self, collection: str, filter: StoreFilter | None = None) -> list[Any]: ...
    def getById(self, collection: str, id: str) -> Any: ...
    def put(self, collection: str, item: JsonObject) -> JsonObject: ...
    def remove(self, collection: str, id: str) -> bool: ...
    def count(self, collection: str, filter: StoreFilter | None = None) -> int: ...


@runtime_checkable
class SyncStoreInQuery(Protocol):
    """Optional collection capability: push ``field IN (...)`` into the backend."""

    def listWhereIn(
        self,
        collection: str,
        field: str,
        values: list[Any],
        filter: StoreFilter | None = None,
    ) -> list[Any]: ...
