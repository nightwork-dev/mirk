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
    TargetUnavailableError,
    compare_expect,
    corpus_dir,
    load_scenarios,
    resolve_target,
    run_scenario,
    scenario_port,
    validate_scenarios,
)

# Ports whose target this checkout cannot build yet. The integrator empties this
# set once vector, search and graph land; a skip outside it is a failure now.
ALLOWED_SKIPPED_PORTS = {"vector", "search", "graph"}

IMPLEMENTED_CAPABILITIES = {"listWhereIn"}

BACKENDS: dict[str, Callable[[], Any]] = {
    "memory": InMemoryStore,
    "sqlite": lambda: SqliteStore(":memory:"),
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
    for port in ("store", "kv", "collection"):
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


def test_ignore_fields_drops_named_fields_from_both_sides() -> None:
    actual = [{"id": "a", "score": 0.5}, {"id": "b", "score": 0.25}]
    expected = [{"id": "a", "score": 99.0}, {"id": "b", "score": -1.0}]
    assert compare_expect(actual, {"values": expected, "ignoreFields": ["score"]}) is None
    assert compare_expect(actual, {"values": expected}) is not None


def test_ignore_fields_combines_with_approx_fields() -> None:
    actual = [{"id": "a", "score": 0.5000001, "note": "x"}]
    expected = [{"id": "a", "score": 0.5, "note": "y"}]
    expect: dict[str, Any] = {
        "values": expected,
        "approxFields": ["score"],
        "tol": 1e-6,
        "ignoreFields": ["note"],
    }
    assert compare_expect(actual, expect) is None


def _scenario_naming(*ports: str) -> Scenario:
    from pathlib import Path

    data: dict[str, Any] = {"id": "synthetic", "ports": list(ports), "steps": []}
    return Scenario(id="synthetic", path=Path("synthetic.json"), data=data)
