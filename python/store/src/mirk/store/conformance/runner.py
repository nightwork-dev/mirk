"""Execute corpus scenarios against a store.

## Adding a port without editing this file

A scenario names the ports it touches. The runner resolves those names to a
target object by convention, so the authors of the vector, search, graph, hash
and artifact ports never edit this module:

- The names ``store``, ``kv``, ``collection`` and ``atomic`` all mean the
  backend store itself: an `InMemoryStore`, or an open `SqliteStore`. ``atomic``
  binds the store (`getVersioned`/`mutateAtomically` live on it directly), not a
  separate facet.
- Any other port name ``p`` resolves by importing first ``mirk.store.<p>`` and,
  if that module does not exist, ``mirk.<p>`` — the store's own ports (``hash``)
  live under the first, a sibling package's ports (``fixtures``, ``artifact``)
  under the second — and calling its module-level factory::

      def conformance_target(backend: str, connection: object) -> object: ...

  ``backend`` is ``"memory"`` or ``"sqlite"``. ``connection`` is that backend's
  open store handle, so a SQLite facet shares the one connection the runner
  already opened rather than opening a second one against the same file.
  Return an object whose methods are named exactly as the corpus spells them.

If neither module exists, or the one that does exposes no ``conformance_target``,
the scenario is a recorded skip rather than a failure. Skips are data: the suite
counts them per port and the integrator makes them fatal.

## The `hash` port's wrapper expansion

JSON cannot express three inputs `hash` scenarios need: negative zero, a lone
surrogate, and the integer/float distinction. Corpus args for the `hash` port
only may contain wrapper objects — exactly one key among ``$num`` (parse this
decimal text as a float64), ``$codepoints`` (build a string from these code
points, lone surrogates allowed), ``$b64`` (raw bytes) or ``$utf8`` (UTF-8 bytes
of this string) — recursively through arrays and objects. `run_scenario`
expands them before dispatch for that port only; every other port's args are
ordinary JSON and mean themselves.

## The `invalidPaths` expect form

Schema validation is the one place the corpus cannot compare messages: Ajv and
`jsonschema` word failures differently, count them differently, and encode
paths differently. A step whose ``expect`` carries ``invalidPaths`` is checked
against the sorted, de-duplicated set of ``"<ref>#<instancePath>"`` strings
built from the `schema-invalid` diagnostics of a validation report, and against
nothing else. A diagnostic of any other code fails the step, so this form
cannot launder a missing reference or a parse error into a clean pass.
"""

from __future__ import annotations

import base64
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
    "compare_invalid_paths",
    "expand_hash_wrappers",
    "normalize",
    "resolve_target",
    "run_scenario",
    "run_step",
    "scenario_port",
]

STORE_PORTS = frozenset({"store", "kv", "collection", "atomic"})


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
    """Build the object a scenario's steps are dispatched onto.

    Tries ``mirk.store.<port>`` first, then ``mirk.<port>`` (S0 ruling 8): the
    store's own extra ports live in the first, a sibling package's ports (e.g.
    ``mirk.fixtures``, ``mirk.artifact``) in the second.
    """
    if port == "store":
        return connection
    candidates = (f"mirk.store.{port}", f"mirk.{port}")
    for module_name in candidates:
        try:
            module = import_module(module_name)
        except ModuleNotFoundError:
            continue
        factory = getattr(module, "conformance_target", None)
        if not callable(factory):
            raise TargetUnavailableError(f"{module_name} exposes no conformance_target")
        target = cast(Any, factory)(backend, connection)
        if target is None:
            raise TargetUnavailableError(f"{module_name}.conformance_target returned None")
        return target
    raise TargetUnavailableError(f"no module {' or '.join(candidates)}")


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


def expand_hash_wrappers(value: Any) -> Any:
    """Replace `hash`-port wrapper objects with the Python value they encode.

    Recurses through plain lists and dicts. A dict is a wrapper only when it has
    exactly one key drawn from the four names below; any other dict (including
    one that happens to share a key name alongside others) is ordinary JSON and
    is walked, not replaced.
    """
    if isinstance(value, list):
        return [expand_hash_wrappers(item) for item in cast(list[Any], value)]
    if isinstance(value, dict):
        mapping = cast(dict[str, Any], value)
        if list(mapping.keys()) == ["$num"]:
            return float(cast(str, mapping["$num"]))
        if list(mapping.keys()) == ["$codepoints"]:
            # A JavaScript string is UTF-16: a high surrogate followed by a low
            # one IS the astral character. Join pairs; keep lone ones.
            units = "".join(chr(int(point)) for point in cast(list[Any], mapping["$codepoints"]))
            return units.encode("utf-16-le", "surrogatepass").decode("utf-16-le", "surrogatepass")
        if list(mapping.keys()) == ["$b64"]:
            return base64.b64decode(cast(str, mapping["$b64"]))
        if list(mapping.keys()) == ["$utf8"]:
            return cast(str, mapping["$utf8"]).encode("utf-8")
        return {key: expand_hash_wrappers(item) for key, item in mapping.items()}
    return value


def run_step(target: object, op: str, args: list[Any]) -> StepOutcome:
    """Dispatch one step, reporting a returned value and a raise distinctly."""
    method = getattr(target, op, None)
    if not callable(method):
        return StepOutcome.raised(f"unsupported op: {op}")
    try:
        return StepOutcome.returned(normalize(method(*args)))
    except Exception as exc:
        return StepOutcome.raised(str(exc))


def compare_invalid_paths(outcome: StepOutcome, expect: dict[str, Any]) -> str | None:
    """Check a `validate` result against the `invalidPaths` expect form.

    Two JSON Schema engines cannot agree on wording, error counts or path
    encodings, so a validation scenario compares only WHICH parts of a document
    failed: the sorted, de-duplicated set of ``"<ref>#<instancePath>"`` strings
    over diagnostics whose code is ``schema-invalid``. A diagnostic with any
    other code fails the step rather than being filtered out, so this form can
    never launder a missing reference or a parse error into a clean pass.
    """
    if not outcome.ok:
        return f"expected a validation report, got a raise: {outcome.message!r}"
    report: Any = outcome.value
    if not isinstance(report, dict) or "diagnostics" not in report:
        return f"$: expected a validation report object, got {report!r}"
    report_obj = cast(dict[str, Any], report)

    raw_diagnostics: Any = report_obj.get("diagnostics")
    if not isinstance(raw_diagnostics, list):
        return f"$.diagnostics: expected an array, got {raw_diagnostics!r}"

    paths: set[str] = set()
    for item in cast(list[Any], raw_diagnostics):
        if not isinstance(item, dict):
            return f"$.diagnostics: expected diagnostic objects, got {item!r}"
        diagnostic = cast(dict[str, Any], item)
        code = diagnostic.get("code")
        if code != "schema-invalid":
            return f"$.diagnostics: unexpected diagnostic code {code!r}; use `value` for those"
        paths.add(f"{diagnostic.get('fixture', '')}#{diagnostic.get('fieldPath', '')}")

    expected_raw: Any = expect["invalidPaths"]
    expected = [str(entry) for entry in cast(list[Any], expected_raw)]
    actual = sorted(paths)
    if actual != expected:
        return f"$.invalidPaths: expected {expected!r}, got {actual!r}"
    reported_ok: Any = report_obj.get("ok")
    if actual and reported_ok is not False:
        return f"$.ok: expected false with {len(actual)} invalid paths, got {reported_ok!r}"
    return None


def run_scenario(target: object, scenario: Scenario) -> list[StepFailure]:
    """Run every step in order, checking each ``expect`` before the next step."""
    failures: list[StepFailure] = []
    expand_args = scenario_port(scenario) == "hash"
    for index, step in enumerate(scenario.steps):
        op = str(step.get("op", ""))
        raw_args = step.get("args")
        args: list[Any] = list(cast(list[Any], raw_args)) if isinstance(raw_args, list) else []
        if expand_args:
            args = [expand_hash_wrappers(item) for item in args]
        result = run_step(target, op, args)
        expect: Any = step.get("expect")
        if not isinstance(expect, dict):
            if not result.ok:
                failures.append(StepFailure(index, op, f"setup raised: {result.message!r}"))
            continue
        clause = cast(dict[str, Any], expect)
        if "invalidPaths" in clause:
            detail = compare_invalid_paths(result, clause)
        else:
            detail = compare_expect(result, clause)
        if detail is not None:
            failures.append(StepFailure(index, op, detail))
            break
    return failures
