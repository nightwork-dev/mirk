"""Replay the language-neutral conformance corpus against every backend.

The corpus at ``<repo>/conformance`` is the contract. A scenario whose port has
no target on this checkout is skipped and the skip is recorded per port; the
integrator empties ``ALLOWED_SKIPPED_PORTS`` and every remaining skip becomes a
failure.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

import pytest

from mirk.store import InMemoryStore, SqliteStore
from mirk.store.conformance import (
    Scenario,
    StepOutcome,
    TargetUnavailableError,
    assertion_free_scenarios,
    compare_expect,
    compare_invalid_paths,
    corpus_dir,
    load_scenarios,
    normalize,
    resolve_target,
    run_scenario,
    run_step,
    scenario_port,
    validate_scenarios,
)

# Ports whose target this checkout cannot build yet. The integrator empties this
# set once vector, search and graph land; a skip outside it is a failure now.
ALLOWED_SKIPPED_PORTS: set[str] = set()

IMPLEMENTED_CAPABILITIES = {"listWhereIn"}

# Version tokens are compared by exact value, so both backends are built with
# the identity the corpus was generated under: a token is `conformance-v<n>`.
BACKENDS: dict[str, Callable[[], Any]] = {
    "memory": lambda: InMemoryStore(version_identity="conformance"),
    "sqlite": lambda: SqliteStore(":memory:", version_identity="conformance"),
}

EXECUTED: list[tuple[str, str, str]] = []
SKIPPED: list[tuple[str, str, str]] = []


def _load() -> tuple[list[Scenario], str | None]:
    try:
        directory = corpus_dir()
    except AssertionError as exc:
        return ([], str(exc))
    scenarios = load_scenarios(directory)
    if not scenarios:
        return ([], f"corpus missing: no scenario files under {directory}")
    return (scenarios, None)


SCENARIOS, CORPUS_ERROR = _load()


def _unsupported_capabilities(scenario: Scenario) -> list[str]:
    return [name for name in scenario.capabilities if name not in IMPLEMENTED_CAPABILITIES]


def test_corpus_is_present() -> None:
    assert CORPUS_ERROR is None, CORPUS_ERROR
    assert SCENARIOS


@pytest.mark.skipif(CORPUS_ERROR is not None, reason="corpus missing")
def test_corpus_validates_against_its_schema() -> None:
    directory = corpus_dir()
    assert (directory / "scenario.schema.json").is_file(), "corpus ships no schema document"
    assert validate_scenarios(SCENARIOS, directory) == len(SCENARIOS)


@pytest.mark.parametrize("backend", sorted(BACKENDS))
@pytest.mark.parametrize(
    "scenario",
    [pytest.param(scenario, id=scenario.id) for scenario in SCENARIOS],
)
def test_scenario(scenario: Scenario, backend: str) -> None:
    port = scenario_port(scenario)
    missing = _unsupported_capabilities(scenario)
    if missing:
        SKIPPED.append((port, scenario.id, backend))
        pytest.skip(f"capabilities not implemented here: {', '.join(missing)}")

    store = BACKENDS[backend]()
    try:
        try:
            target = resolve_target(port, backend, store)
        except TargetUnavailableError as exc:
            SKIPPED.append((port, scenario.id, backend))
            pytest.skip(f"no target for port {port!r}: {exc}")
        failures = run_scenario(target, scenario)
    finally:
        close = getattr(store, "close", None)
        if callable(close):
            close()

    assert not failures, f"{scenario.id} on {backend}: " + "; ".join(
        str(failure) for failure in failures
    )
    EXECUTED.append((port, scenario.id, backend))


@pytest.mark.skipif(CORPUS_ERROR is not None, reason="corpus missing")
def test_skipped_ports_are_allowed() -> None:
    """Every skip names a port the integrator still expects to be missing."""
    skipped_ports = {port for port, _, _ in SKIPPED}
    assert skipped_ports <= ALLOWED_SKIPPED_PORTS, (
        f"skips on ports that should run here: {sorted(skipped_ports - ALLOWED_SKIPPED_PORTS)}"
    )


@pytest.mark.skipif(CORPUS_ERROR is not None, reason="corpus missing")
def test_every_corpus_port_either_ran_or_was_skipped() -> None:
    """Anti-vacuity: no port silently disappears between the corpus and the run."""
    executed_ports = {port for port, _, _ in EXECUTED}
    skipped_ports = {port for port, _, _ in SKIPPED}
    corpus_ports = {scenario_port(scenario) for scenario in SCENARIOS}
    assert executed_ports | skipped_ports == corpus_ports
    assert executed_ports, "no corpus scenario executed"

    for port in executed_ports:
        for backend in BACKENDS:
            count = sum(1 for p, _, b in EXECUTED if p == port and b == backend)
            assert count > 0, f"port {port} executed no scenario on {backend}"


# ── Harness contracts the corpus cannot express ──────────────────────────────


def test_store_ports_resolve_to_the_backend_itself() -> None:
    store = InMemoryStore()
    for port in ("store", "kv", "collection", "atomic"):
        assert resolve_target(scenario_port(_scenario_naming(port)), "memory", store) is store


def test_a_missing_port_module_is_a_target_failure_not_a_crash() -> None:
    with pytest.raises(TargetUnavailableError) as info:
        resolve_target("definitely_not_a_port", "memory", InMemoryStore())
    assert "no module mirk.store.definitely_not_a_port" in str(info.value)


def test_a_module_without_the_factory_is_a_target_failure() -> None:
    with pytest.raises(TargetUnavailableError) as info:
        resolve_target("types", "memory", InMemoryStore())
    assert "exposes no conformance_target" in str(info.value)


def test_scenario_port_rejects_two_non_store_ports() -> None:
    with pytest.raises(TargetUnavailableError):
        scenario_port(_scenario_naming("vector", "graph"))


def test_hash_port_resolves_via_mirk_store_hash() -> None:
    """S0: `hash` is a zero-native target, resolved without a store connection."""
    target = resolve_target("hash", "memory", InMemoryStore())
    from mirk.store.canonical import canonical_json

    assert target.canonicalJson({"b": 1, "a": 2}) == canonical_json({"b": 1, "a": 2})  # type: ignore[attr-defined]


def test_a_missing_port_falls_back_from_mirk_store_to_mirk() -> None:
    """S0 ruling 8: resolution tries `mirk.store.<p>` then `mirk.<p>` before failing."""
    with pytest.raises(TargetUnavailableError) as info:
        resolve_target("definitely_not_a_port", "memory", InMemoryStore())
    assert "mirk.store.definitely_not_a_port" in str(info.value)
    assert "mirk.definitely_not_a_port" in str(info.value)


def test_ignore_fields_drops_named_fields_from_both_sides() -> None:
    actual = [{"id": "a", "score": 0.5}, {"id": "b", "score": 0.25}]
    expected = [{"id": "a", "score": 99.0}, {"id": "b", "score": -1.0}]
    outcome = StepOutcome.returned(actual)
    assert compare_expect(outcome, {"values": expected, "ignoreFields": ["score"]}) is None
    assert compare_expect(outcome, {"values": expected}) is not None


def test_ignore_fields_combines_with_approx_fields() -> None:
    actual = [{"id": "a", "score": 0.5000001, "note": "x"}]
    expected = [{"id": "a", "score": 0.5, "note": "y"}]
    expect: dict[str, Any] = {
        "values": expected,
        "approxFields": ["score"],
        "tol": 1e-6,
        "ignoreFields": ["note"],
    }
    assert compare_expect(StepOutcome.returned(actual), expect) is None


def _scenario_naming(*ports: str) -> Scenario:
    from pathlib import Path

    data: dict[str, Any] = {"id": "synthetic", "ports": list(ports), "steps": []}
    return Scenario(id="synthetic", path=Path("synthetic.json"), data=data)


# ── Regressions from the 2026-09-01 review ───────────────────────────────────


def test_a_stored_record_shaped_like_a_raise_is_still_a_value() -> None:
    """P1-6: the raise/return distinction comes from the outcome, not the shape.

    Without the ``StepOutcome`` split this record fails its value expectation
    and passes a ``throws`` expectation instead.
    """
    record = {"id": "x", "ok": False, "message": "oops"}
    store = InMemoryStore()
    store.put("c", record)
    outcome = run_step(store, "getById", ["c", "x"])

    assert outcome.ok is True
    assert outcome.value == record
    assert compare_expect(outcome, {"value": record}) is None
    assert compare_expect(outcome, {"throws": "oops"}) is not None


def test_a_raising_step_reports_a_raise() -> None:
    """The other half of P1-6: a real raise still satisfies ``throws``."""
    outcome = run_step(InMemoryStore(), "put", ["c", {"no": "id"}])
    assert outcome.ok is False
    assert compare_expect(outcome, {"throws": outcome.message}) is None
    assert compare_expect(outcome, {"value": None}) is not None


def test_compare_expect_refuses_a_raw_dict() -> None:
    """P1-6: a bare mapping can never be mistaken for an outcome again."""
    with pytest.raises(TypeError) as info:
        compare_expect({"ok": False, "message": "oops"}, {"throws": "oops"})  # type: ignore[arg-type]
    assert "StepOutcome" in str(info.value)


def test_an_unexpected_approx_field_fails() -> None:
    """P2-2: an approx field absent from the expected row is a failure."""
    outcome = StepOutcome.returned([{"id": "a", "score": 1}])
    detail = compare_expect(outcome, {"values": [{"id": "a"}], "approxFields": ["score"]})
    assert detail is not None
    assert "unexpected" in detail


def test_a_missing_approx_field_fails() -> None:
    """The mirror of P2-2: expected-only approx field is still a failure."""
    outcome = StepOutcome.returned([{"id": "a"}])
    detail = compare_expect(
        outcome, {"values": [{"id": "a", "score": 1}], "approxFields": ["score"]}
    )
    assert detail is not None
    assert "missing" in detail


def test_the_assertion_free_detector_names_the_scenario() -> None:
    """P1-7: a scenario whose steps are all setup is reported by id."""
    setup_only = _scenario_with_steps("setup-only", [{"op": "set", "args": ["k", 1]}])
    checked = _scenario_with_steps(
        "checked",
        [{"op": "set", "args": ["k", 1]}, {"op": "get", "args": ["k"], "expect": {"value": 1}}],
    )
    assert assertion_free_scenarios([setup_only, checked]) == ["setup-only"]


@pytest.mark.skipif(CORPUS_ERROR is not None, reason="corpus missing")
def test_every_corpus_scenario_asserts_something() -> None:
    """P1-7: no corpus scenario replays green without checking a result."""
    barren = assertion_free_scenarios(SCENARIOS)
    assert not barren, f"scenarios with no expect clause: {barren}"


def _scenario_with_steps(identifier: str, steps: list[dict[str, Any]]) -> Scenario:
    from pathlib import Path

    data: dict[str, Any] = {"id": identifier, "ports": ["store"], "steps": steps}
    return Scenario(id=identifier, path=Path(f"{identifier}.json"), data=data)


# ── The `fixtures` port and the `invalidPaths` expect form ───────────────────


def test_the_fixtures_port_resolves_through_the_sibling_package() -> None:
    """F2: `mirk.store.fixtures` does not exist, so resolution falls through to
    `mirk.fixtures`. The runner never names the package."""
    pytest.importorskip("mirk.fixtures")
    target = resolve_target("fixtures", "memory", InMemoryStore())
    assert callable(target.configure)  # type: ignore[attr-defined]


def _validation_report(*diagnostics: dict[str, Any]) -> StepOutcome:
    return StepOutcome.returned({"ok": not diagnostics, "diagnostics": list(diagnostics)})


def _invalid(fixture: str, field_path: str) -> dict[str, Any]:
    return {
        "severity": "error",
        "code": "schema-invalid",
        "message": "engine-specific wording",
        "fixture": fixture,
        "fieldPath": field_path,
    }


def test_normalize_renders_a_non_finite_float_as_null() -> None:
    """`JSON.stringify` writes `null` for NaN and the infinities, so the corpus
    can only ever carry `null` and both runners must produce it. Refusing to
    encode one turned a returned value into a reported raise."""
    assert normalize(float("nan")) is None
    assert normalize(float("inf")) is None
    assert normalize(float("-inf")) is None
    assert normalize({"a": [float("nan"), 1.5], "b": float("-inf")}) == {
        "a": [None, 1.5],
        "b": None,
    }


def test_invalid_paths_compares_the_sorted_deduplicated_path_set() -> None:
    outcome = _validation_report(
        _invalid("theme:a", "palette.bg"),
        _invalid("theme:a", "name"),
        _invalid("theme:a", "name"),
    )
    expect: dict[str, Any] = {"invalidPaths": ["theme:a#name", "theme:a#palette.bg"]}
    assert compare_invalid_paths(outcome, expect) is None


def test_invalid_paths_ignores_the_engine_specific_message() -> None:
    """The whole point of the form: two engines word the same failure
    differently, so only the instance path is contractual."""
    ajv_like = _validation_report({**_invalid("theme:a", "name"), "message": "must be string"})
    python_like = _validation_report({**_invalid("theme:a", "name"), "message": "5 is not of type"})
    expect: dict[str, Any] = {"invalidPaths": ["theme:a#name"]}
    assert compare_invalid_paths(ajv_like, expect) is None
    assert compare_invalid_paths(python_like, expect) is None


def test_invalid_paths_fails_a_diagnostic_with_another_code() -> None:
    outcome = _validation_report(
        {
            "severity": "error",
            "code": "missing-reference",
            "message": "x",
            "fixture": "theme:a",
        }
    )
    detail = compare_invalid_paths(outcome, {"invalidPaths": []})
    assert detail is not None
    assert "missing-reference" in detail


def test_invalid_paths_requires_ok_false_when_paths_are_present() -> None:
    outcome = StepOutcome.returned({"ok": True, "diagnostics": [_invalid("theme:a", "name")]})
    detail = compare_invalid_paths(outcome, {"invalidPaths": ["theme:a#name"]})
    assert detail is not None
    assert "$.ok" in detail


def test_invalid_paths_accepts_a_clean_report() -> None:
    assert compare_invalid_paths(_validation_report(), {"invalidPaths": []}) is None


def test_invalid_paths_rejects_a_raise_and_a_non_report() -> None:
    assert compare_invalid_paths(StepOutcome.raised("boom"), {"invalidPaths": []}) is not None
    assert compare_invalid_paths(StepOutcome.returned([1, 2]), {"invalidPaths": []}) is not None


def test_invalid_paths_requires_ok_true_when_no_path_is_reported() -> None:
    """A report that claims failure but names nothing is a bug in the port, not
    a clean pass. The TypeScript comparator rejects it, so this one does too."""
    outcome = StepOutcome.returned({"ok": False, "diagnostics": []})
    detail = compare_invalid_paths(outcome, {"invalidPaths": []})
    assert detail is not None
    assert "$.ok" in detail


def test_invalid_paths_requires_ok_to_be_a_boolean() -> None:
    reports: list[dict[str, Any]] = [
        {"diagnostics": []},
        {"ok": "yes", "diagnostics": []},
        {"ok": 1, "diagnostics": []},
    ]
    for report in reports:
        detail = compare_invalid_paths(StepOutcome.returned(report), {"invalidPaths": []})
        assert detail is not None, report
        assert "$.ok" in detail


def test_invalid_paths_requires_a_string_fixture_and_field_path() -> None:
    bad_fixture = StepOutcome.returned(
        {"ok": False, "diagnostics": [{**_invalid("theme:a", "name"), "fixture": 7}]}
    )
    assert compare_invalid_paths(bad_fixture, {"invalidPaths": ["7#name"]}) is not None
    bad_path = StepOutcome.returned(
        {"ok": False, "diagnostics": [{**_invalid("theme:a", "name"), "fieldPath": 3}]}
    )
    assert compare_invalid_paths(bad_path, {"invalidPaths": ["theme:a#3"]}) is not None


def test_invalid_paths_treats_a_missing_field_path_as_the_document_itself() -> None:
    diagnostic = {k: v for k, v in _invalid("theme:a", "").items() if k != "fieldPath"}
    outcome = StepOutcome.returned({"ok": False, "diagnostics": [diagnostic]})
    assert compare_invalid_paths(outcome, {"invalidPaths": ["theme:a#"]}) is None
