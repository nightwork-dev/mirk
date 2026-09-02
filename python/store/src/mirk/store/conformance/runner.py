"""Execute corpus scenarios against a store.

## Adding a port without editing this file

A scenario names the ports it touches. The runner resolves those names to a
target object by convention, so the authors of the vector, search and graph
ports never edit this module:

- The names ``store``, ``kv`` and ``collection`` all mean the backend store
  itself: an `InMemoryStore`, or an open `SqliteStore`.
- Any other port name ``p`` resolves by importing ``mirk.store.<p>`` and calling
  its module-level factory::

      def conformance_target(backend: str, connection: object) -> object: ...

  ``backend`` is ``"memory"`` or ``"sqlite"``. ``connection`` is that backend's
  open store handle, so a SQLite facet shares the one connection the runner
  already opened rather than opening a second one against the same file.
  Return an object whose methods are named exactly as the corpus spells them.

If the module does not exist, or exposes no ``conformance_target``, the scenario
is a recorded skip rather than a failure. Skips are data: the suite counts them
per port and the integrator makes them fatal.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from importlib import import_module
from typing import Any, cast

from .compare import compare_expect
from .loader import Scenario

__all__ = [
    "STORE_PORTS",
    "StepFailure",
    "StepOutcome",
    "TargetUnavailableError",
    "normalize",
    "resolve_target",
    "run_scenario",
    "run_step",
    "scenario_port",
]

STORE_PORTS = frozenset({"store", "kv", "collection"})


class TargetUnavailableError(Exception):
    """No target could be built for a scenario's port on this backend."""


@dataclass(frozen=True, slots=True)
class StepOutcome:
    """What one step did: a returned value, or a raise.

    The distinction is carried in ``ok``, never inferred from the shape of the
    value. A stored record that happens to contain ``{"ok": false, "message":
    ...}`` is a value like any other.
    """

    ok: bool
    value: Any = None
    message: str | None = None

    @staticmethod
    def returned(value: Any) -> StepOutcome:
        return StepOutcome(ok=True, value=value)

    @staticmethod
    def raised(message: str) -> StepOutcome:
        return StepOutcome(ok=False, message=message)


@dataclass(frozen=True, slots=True)
class StepFailure:
    """A step whose result did not match its ``expect`` clause."""

    index: int
    op: str
    detail: str

    def __str__(self) -> str:
        return f"step {self.index} ({self.op}): {self.detail}"


def scenario_port(scenario: Scenario) -> str:
    """The single port whose target runs this scenario.

    Store-shaped port names collapse to ``store``. A scenario naming more than
    one non-store port has no single target and cannot be replayed.
    """
    specific = [port for port in scenario.ports if port not in STORE_PORTS]
    if not specific:
        return "store"
    if len(set(specific)) > 1:
        raise TargetUnavailableError(
            f"{scenario.id} names several non-store ports: {sorted(set(specific))}"
        )
    return specific[0]


def resolve_target(port: str, backend: str, connection: object) -> object:
    """Build the object a scenario's steps are dispatched onto."""
    if port == "store":
        return connection
    try:
        module = import_module(f"mirk.store.{port}")
    except ModuleNotFoundError as exc:
        raise TargetUnavailableError(f"no module mirk.store.{port}") from exc
    factory = getattr(module, "conformance_target", None)
    if not callable(factory):
        raise TargetUnavailableError(f"mirk.store.{port} exposes no conformance_target")
    target = cast(Any, factory)(backend, connection)
    if target is None:
        raise TargetUnavailableError(f"mirk.store.{port}.conformance_target returned None")
    return target


def normalize(value: Any) -> Any:
    """Reduce a result to plain JSON so it can be compared with corpus literals."""
    if value is None or isinstance(value, bool | int | float | str):
        return value
    return json.loads(json.dumps(value, allow_nan=False, ensure_ascii=False, default=_fallback))


def _fallback(value: Any) -> Any:
    to_json = getattr(value, "to_json", None)
    if callable(to_json):
        return to_json()
    if hasattr(value, "__dict__"):
        fields = cast(dict[str, Any], vars(value))
        return {key: item for key, item in fields.items() if not key.startswith("_")}
    return str(value)


def run_step(target: object, op: str, args: list[Any]) -> StepOutcome:
    """Dispatch one step, reporting a returned value and a raise distinctly."""
    method = getattr(target, op, None)
    if not callable(method):
        return StepOutcome.raised(f"unsupported op: {op}")
    try:
        return StepOutcome.returned(normalize(method(*args)))
    except Exception as exc:
        return StepOutcome.raised(str(exc))


def run_scenario(target: object, scenario: Scenario) -> list[StepFailure]:
    """Run every step in order, checking each ``expect`` before the next step."""
    failures: list[StepFailure] = []
    for index, step in enumerate(scenario.steps):
        op = str(step.get("op", ""))
        raw_args = step.get("args")
        args: list[Any] = list(cast(list[Any], raw_args)) if isinstance(raw_args, list) else []
        result = run_step(target, op, args)
        expect: Any = step.get("expect")
        if not isinstance(expect, dict):
            if not result.ok:
                failures.append(StepFailure(index, op, f"setup raised: {result.message!r}"))
            continue
        detail = compare_expect(result, cast(dict[str, Any], expect))
        if detail is not None:
            failures.append(StepFailure(index, op, detail))
            break
    return failures
