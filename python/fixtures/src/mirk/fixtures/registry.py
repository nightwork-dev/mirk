"""The fixture type registry.

`types()` order is observable: it drives discovery order in `list()` and
`validate()`, and therefore which of several competing errors a broken pack
reports first. It is Unicode code point order in both languages.
"""

from __future__ import annotations

from .errors import FixtureError
from .types import FixtureTypeDefinition

__all__ = ["FixtureRegistry", "create_fixture_registry"]


class FixtureRegistry:
    """Maps a type name to its definition. Registration is one-shot per name."""

    def __init__(self) -> None:
        self._defs: dict[str, FixtureTypeDefinition] = {}

    def register(self, definition: FixtureTypeDefinition) -> None:
        type_name = definition["type"]
        # A type with no contract at all would load anything, silently, in
        # every language. `jsonSchema: True` is the explicit way to say
        # "any value". Checked before the duplicate rule, as in TypeScript.
        if definition.get("jsonSchema") is None and not callable(definition.get("schema")):
            raise FixtureError(
                {
                    "severity": "error",
                    "code": "missing-schema",
                    "message": (
                        f'Fixture type "{type_name}" must declare "jsonSchema" or "schema".'
                    ),
                    "hint": (
                        "Use `jsonSchema: True` for a type whose documents are unconstrained."
                    ),
                }
            )
        if type_name in self._defs:
            raise FixtureError(
                {
                    "severity": "error",
                    "code": "duplicate-type",
                    "message": f'Fixture type "{type_name}" is already registered.',
                }
            )
        self._defs[type_name] = definition

    def get(self, type_name: str) -> FixtureTypeDefinition | None:
        return self._defs.get(type_name)

    def has(self, type_name: str) -> bool:
        return type_name in self._defs

    def types(self) -> list[str]:
        return sorted(self._defs)


def create_fixture_registry() -> FixtureRegistry:
    return FixtureRegistry()
