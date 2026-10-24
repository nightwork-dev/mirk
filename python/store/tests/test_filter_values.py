"""Filter values the JSON corpus cannot carry: non-finite numbers, integers above 2^53."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

import pytest

from mirk.store import InMemoryStore, SqliteStore, StoreFilterError

STORES: dict[str, Callable[[], Any]] = {
    "memory": InMemoryStore,
    "sqlite": lambda: SqliteStore(":memory:"),
}


@pytest.fixture(params=sorted(STORES))
def store(request: pytest.FixtureRequest) -> Any:
    return STORES[request.param]()


@pytest.mark.parametrize("value", [float("nan"), float("inf"), float("-inf")])
def test_a_non_finite_number_is_rejected(store: Any, value: float) -> None:
    store.put("items", {"id": "a", "f": 1})
    calls: list[Callable[[], Any]] = [
        lambda: store.list("items", {"where": {"f": value}}),
        lambda: store.count("items", {"where": {"f": value}}),
        lambda: store.listWhereIn("items", "f", [1, value]),
    ]
    for call in calls:
        with pytest.raises(StoreFilterError) as raised:
            call()
        assert raised.value.code == "non-finite-number"


def test_an_integer_above_2_53_matches_the_value_it_was_stored_as(store: Any) -> None:
    store.put("items", {"id": "a", "f": 9007199254740993})
    assert [item["id"] for item in store.list("items", {"where": {"f": 9007199254740993}})] == ["a"]
    assert [item["id"] for item in store.listWhereIn("items", "f", [9007199254740993])] == ["a"]
    assert store.count("items", {"where": {"f": {"gte": 9007199254740993}}}) == 1


def test_more_values_than_one_statement_binds_is_a_typed_error(store: Any) -> None:
    with pytest.raises(StoreFilterError) as raised:
        store.listWhereIn("items", "f", list(range(32_767)))
    assert raised.value.code == "too-many-in-values"


@pytest.mark.parametrize("value", [10**400, -(10**400)])
def test_an_integer_no_double_can_hold_is_a_typed_error(store: Any, value: int) -> None:
    store.put("items", {"id": "a", "f": 1})
    cases: list[tuple[str, Callable[[], Any]]] = [
        ("invalid-range-bound", lambda: store.list("items", {"where": {"f": {"gte": value}}})),
        ("non-finite-number", lambda: store.list("items", {"where": {"f": value}})),
        ("non-finite-number", lambda: store.listWhereIn("items", "f", [value])),
    ]
    for code, call in cases:
        with pytest.raises(StoreFilterError) as raised:
            call()
        assert raised.value.code == code
