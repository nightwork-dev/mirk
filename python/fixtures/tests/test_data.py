from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from mirk.data import merge_layers, merge_overlay

CASES = json.loads(
    (
        Path(__file__).resolve().parents[3] / "packages/fixtures/test/authored-data-cases.json"
    ).read_text()
)


def test_shared_overlay_cases() -> None:
    for case in CASES["overlay"]:
        assert merge_overlay(case["base"], case["over"]) == case["expected"]


def test_shared_layer_cases() -> None:
    for case in CASES["layers"]:
        assert (
            merge_layers(case["base"], case["over"], tuple(case["appendKeys"])) == case["expected"]
        )


def test_reference_contracts() -> None:
    base: dict[str, Any] = {"unchanged": [], "nested": {"a": 1}}
    incoming: dict[str, Any] = {"new": [], "nested": {"b": []}}
    overlay = merge_overlay(base, incoming)
    assert overlay["unchanged"] is base["unchanged"]
    assert overlay["new"] is incoming["new"]
    assert overlay["nested"]["b"] is incoming["nested"]["b"]
    layered = merge_layers(base, incoming)
    assert layered["unchanged"] is not base["unchanged"]
    assert layered["new"] is not incoming["new"]
    assert layered["nested"]["b"] is not incoming["nested"]["b"]
