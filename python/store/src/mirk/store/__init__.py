"""Mirk store: substrate-agnostic KV and collection primitives.

``mirk`` is a PEP 420 namespace package: there is no ``mirk/__init__.py``, so a
later ``mirk-fixtures`` distribution can add ``mirk.fixtures`` alongside this one.
"""

from .atomic import (
    DEFAULT_ATOMIC_LIMITS,
    IN_PROCESS_ATOMIC_LIMITS,
    MAX_ATOMIC_OUTCOME_BYTES,
    AtomicMutationBackendError,
    AtomicMutationIndeterminateError,
    AtomicMutationLimits,
    AtomicMutationRejectedError,
    ValidatedRequest,
    compare_targets,
    resolve_atomic_limits,
    target_key,
    validate_atomic_request,
)
from .canonical import CanonicalJsonError, CanonicalJsonErrorCode, canonical_json, sha256_hex
from .filter import (
    StoreFilterError,
    StoreFilterErrorCode,
    apply_filter,
    json_equal,
    matches_where,
)
from .memory import InMemoryStore
from .namespace import NamespacedStore, NamespaceError, NamespaceErrorCode, namespace_store
from .search import SearchInputError, SearchInputErrorCode
from .sqlite import SqliteAdapterError, SqliteAdapterErrorCode, SqliteStore, hash_name
from .types import Json, JsonObject, StoreFilter, StoreMeta, SyncStore, SyncStoreInQuery
from .vector import VectorInputError, VectorInputErrorCode

__all__ = [
    "DEFAULT_ATOMIC_LIMITS",
    "IN_PROCESS_ATOMIC_LIMITS",
    "MAX_ATOMIC_OUTCOME_BYTES",
    "AtomicMutationBackendError",
    "AtomicMutationIndeterminateError",
    "AtomicMutationLimits",
    "AtomicMutationRejectedError",
    "CanonicalJsonError",
    "CanonicalJsonErrorCode",
    "InMemoryStore",
    "Json",
    "JsonObject",
    "NamespaceError",
    "NamespaceErrorCode",
    "NamespacedStore",
    "SearchInputError",
    "SearchInputErrorCode",
    "SqliteAdapterError",
    "SqliteAdapterErrorCode",
    "SqliteStore",
    "StoreFilter",
    "StoreFilterError",
    "StoreFilterErrorCode",
    "StoreMeta",
    "SyncStore",
    "SyncStoreInQuery",
    "ValidatedRequest",
    "VectorInputError",
    "VectorInputErrorCode",
    "apply_filter",
    "canonical_json",
    "compare_targets",
    "hash_name",
    "json_equal",
    "matches_where",
    "namespace_store",
    "resolve_atomic_limits",
    "sha256_hex",
    "target_key",
    "validate_atomic_request",
]
