"""Shared helpers for the fixtures suite.

Definitions are declared as plain dicts and cast at this boundary: a fixture
type is a `TypedDict`, and spelling every literal out with the exact optional
keys would bury the behaviour each test is about.
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any, cast

from mirk.fixtures import FixtureLoader, FixtureRegistry
from mirk.fixtures.conformance import json_schema_validator_factory
from mirk.fixtures.sources.memory import MemoryFixtureSource
from mirk.fixtures.types import Diagnostic, FixtureTypeDefinition


def passthrough(value: Any) -> Any:
    """A `schema` callable that accepts everything and transforms nothing."""
    return {"value": value}


def definition(fields: dict[str, Any]) -> FixtureTypeDefinition:
    return cast(FixtureTypeDefinition, fields)


def registry(*definitions: dict[str, Any]) -> FixtureRegistry:
    reg = FixtureRegistry()
    for declared in definitions:
        reg.register(definition(declared))
    return reg


def memory(id: str, files: dict[str, str]) -> MemoryFixtureSource:
    return MemoryFixtureSource(id, files)


def loader(reg: FixtureRegistry, sources: Sequence[Any], **kwargs: Any) -> FixtureLoader:
    kwargs.setdefault("json_schema_validator", json_schema_validator_factory)
    return FixtureLoader(reg, sources, **kwargs)


def field(diagnostic: Diagnostic, name: str) -> Any:
    """Read an optional diagnostic field without a required-key assertion."""
    return cast(dict[str, Any], diagnostic).get(name)
