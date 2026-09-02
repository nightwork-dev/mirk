"""Discover and validate the language-neutral conformance corpus.

The corpus lives at ``<repo>/conformance`` and is read out of the repository, not
out of package data: the wheel does not ship scenarios.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from importlib import import_module
from pathlib import Path
from typing import Any, cast

__all__ = [
    "CORPUS_DIRNAME",
    "Scenario",
    "assertion_free_scenarios",
    "corpus_dir",
    "load_scenarios",
    "repo_root",
    "validate_scenarios",
]

CORPUS_DIRNAME = "conformance"
_ROOT_MARKERS = ("pnpm-workspace.yaml", ".git")


@dataclass(frozen=True, slots=True)
class Scenario:
    """One corpus file: a sequence of steps run against a fresh store."""

    id: str
    path: Path
    data: dict[str, Any]

    @property
    def ports(self) -> list[str]:
        value = self.data.get("ports")
        return [str(port) for port in cast(list[Any], value)] if isinstance(value, list) else []

    @property
    def capabilities(self) -> list[str]:
        value = self.data.get("capabilities")
        if not isinstance(value, list):
            return []
        return [str(capability) for capability in cast(list[Any], value)]

    @property
    def has_assertion(self) -> bool:
        """Whether any step checks a result.

        A scenario whose steps are all setup replays green while proving
        nothing, so the suite refuses it rather than counting it as coverage.
        """
        return any(isinstance(step.get("expect"), dict) for step in self.steps)

    @property
    def steps(self) -> list[dict[str, Any]]:
        value = self.data.get("steps")
        if not isinstance(value, list):
            return []
        return [cast(dict[str, Any], step) for step in cast(list[Any], value)]


def repo_root() -> Path:
    """Walk up from this file to the repository that owns the corpus.

    The package sits at ``python/store/src/mirk/store/conformance``, so a fixed
    parent count is fragile; a marker search is stable if the layout moves.
    """
    here = Path(__file__).resolve()
    for candidate in here.parents:
        if any((candidate / marker).exists() for marker in _ROOT_MARKERS):
            return candidate
    raise AssertionError(f"no repository root above {here}")


def corpus_dir() -> Path:
    """The corpus directory. ``MIRK_CONFORMANCE_DIR`` overrides the lookup."""
    override = os.environ.get("MIRK_CONFORMANCE_DIR")
    directory = Path(override) if override else repo_root() / CORPUS_DIRNAME
    assert directory.is_dir(), f"conformance corpus missing at {directory}"
    return directory


def load_scenarios(directory: Path | None = None) -> list[Scenario]:
    """Every ``*.json`` scenario under the corpus, sorted by path."""
    root = directory if directory is not None else corpus_dir()
    scenarios: list[Scenario] = []
    for path in sorted(root.rglob("*.json")):
        if path.name == "scenario.schema.json":
            continue
        data: dict[str, Any] = json.loads(path.read_text(encoding="utf-8"))
        identifier = str(data.get("id") or path.relative_to(root).with_suffix("").as_posix())
        scenarios.append(Scenario(id=identifier, path=path, data=data))
    return scenarios


def validate_scenarios(scenarios: list[Scenario], directory: Path | None = None) -> int:
    """Validate every scenario against the corpus JSON Schema.

    Returns the number validated, or 0 when the schema document is absent.
    """
    root = directory if directory is not None else corpus_dir()
    schema_path = root / "scenario.schema.json"
    if not schema_path.is_file():
        return 0
    # jsonschema ships no type information, so reach it dynamically and keep the
    # untyped surface confined to these few lines.
    validators: Any = import_module("jsonschema.validators")

    schema: dict[str, Any] = json.loads(schema_path.read_text(encoding="utf-8"))
    factory: Any = validators.validator_for(schema)
    factory.check_schema(schema)
    validator: Any = factory(schema)
    for scenario in scenarios:
        raw_errors: list[Any] = list(validator.iter_errors(scenario.data))
        if not raw_errors:
            continue
        first: Any = raw_errors[0]
        location = "/".join(str(part) for part in list(first.path))
        raise AssertionError(f"{scenario.path}: {location or '<root>'}: {first.message!s}")
    return len(scenarios)


def assertion_free_scenarios(scenarios: list[Scenario]) -> list[str]:
    """The ids of scenarios that assert nothing, in corpus order."""
    return [scenario.id for scenario in scenarios if not scenario.has_assertion]
