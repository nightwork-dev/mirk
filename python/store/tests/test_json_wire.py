from typing import Any

import pytest

from mirk.store.filter import dumps_json


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        ([1e-7, 1e-6, 1e20, 1e21, -0.0], "[1e-7,0.000001,100000000000000000000,1e+21,0]"),
        ({"z": {"2": 2, "1": 1, "b": 3, "a": 4}}, '{"z":{"1":1,"2":2,"b":3,"a":4}}'),
        (["key", "\ud800🌱"], '["key","\\ud800🌱"]'),
    ],
    ids=["number-spelling", "property-order", "unicode"],
)
def test_persistence_json_matches_javascript_wire_tokens(value: Any, expected: str) -> None:
    assert dumps_json(value) == expected
