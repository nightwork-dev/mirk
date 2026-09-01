"""Report per-port replay counts in the terminal summary.

A receipt needs the numbers, and a run that replays zero scenarios is not a
receipt. The counts print on every run, not only a verbose one.
"""

from __future__ import annotations

from typing import Any

import test_conformance


def _tally(rows: list[tuple[str, str, str]]) -> dict[str, int]:
    counts: dict[str, int] = {}
    for port, _, _ in rows:
        counts[port] = counts.get(port, 0) + 1
    return counts


def _render(counts: dict[str, int]) -> str:
    return ", ".join(f"{port}={count}" for port, count in sorted(counts.items()))


def pytest_terminal_summary(terminalreporter: Any) -> None:
    executed = test_conformance.EXECUTED
    skipped = test_conformance.SKIPPED
    if not executed and not skipped:
        return
    terminalreporter.write_line(
        f"conformance executed: {len(executed)} runs by port [{_render(_tally(executed))}]"
    )
    by_backend: dict[str, int] = {}
    for _, _, backend in executed:
        by_backend[backend] = by_backend.get(backend, 0) + 1
    terminalreporter.write_line(
        f"conformance executed by backend: {_render(by_backend)}"
    )
    if skipped:
        terminalreporter.write_line(
            f"conformance skipped: {len(skipped)} runs by port [{_render(_tally(skipped))}]"
        )
