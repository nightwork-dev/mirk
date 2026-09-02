"""Conformance target for the `hash` port: `mirk.store.canonical` over the wire.

`hash` is a zero-native, backend-independent target (S0 ruling, `docs/python-port/
plan-phase2.md`): the corpus dispatches `canonicalJson`, `sha256Hex`, `sha256Bytes`
and `canonicalDigest` onto it, spelled exactly as the TypeScript target spells them
so the runner's generic step dispatch (`getattr(target, op)`) needs no port-specific
branching.
"""

from __future__ import annotations

from typing import Any

from .canonical import canonical_digest, canonical_json, sha256_hex, sha256_hex_bytes

__all__ = ["conformance_target"]


class _HashTarget:
    def canonicalJson(self, value: object) -> str:
        return canonical_json(value)

    def sha256Hex(self, text: str) -> str:
        return sha256_hex(text)

    def sha256Bytes(self, data: bytes) -> dict[str, Any]:
        return {"algorithm": "sha256", "value": sha256_hex_bytes(data), "sizeBytes": len(data)}

    def canonicalDigest(self, value: object) -> str:
        return canonical_digest(value)


def conformance_target(backend: str, connection: object) -> object:
    """Backend-independent: `backend` and `connection` are ignored."""
    del backend, connection
    return _HashTarget()
