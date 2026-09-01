"""Mirk store: substrate-agnostic KV and collection primitives.

``mirk`` is a PEP 420 namespace package: there is no ``mirk/__init__.py``, so a
later ``mirk-fixtures`` distribution can add ``mirk.fixtures`` alongside this one.
"""

from .filter import apply_filter, json_equal, matches_where
from .memory import InMemoryStore
from .namespace import NamespacedStore, namespace_store
from .sqlite import SqliteStore, hash_name
from .types import Json, JsonObject, StoreFilter, StoreMeta, SyncStore, SyncStoreInQuery

__all__ = [
    "InMemoryStore",
    "Json",
    "JsonObject",
    "NamespacedStore",
    "SqliteStore",
    "StoreFilter",
    "StoreMeta",
    "SyncStore",
    "SyncStoreInQuery",
    "apply_filter",
    "hash_name",
    "json_equal",
    "matches_where",
    "namespace_store",
]
