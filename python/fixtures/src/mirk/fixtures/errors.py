"""Fixture errors and the diagnostic adapter.

`str(error)` is the diagnostic message verbatim, which is what the conformance
corpus compares for every error this package raises itself.
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any, cast

from .types import Diagnostic, SchemaIssue

__all__ = [
    "FixtureError",
    "FixtureValidationError",
    "diagnostics_from_error",
    "format_issue_path",
]


class FixtureError(Exception):
    """An error carrying the diagnostic a report would show for it."""

    def __init__(self, diagnostic: Diagnostic) -> None:
        super().__init__(diagnostic["message"])
        self.diagnostic: Diagnostic = diagnostic


class FixtureValidationError(FixtureError):
    """Schema validation failed. Carries every issue, not only the first."""

    def __init__(
        self,
        fixture: str,
        source: str,
        path: str,
        issues: Sequence[SchemaIssue],
    ) -> None:
        joined = "; ".join(issue.get("message", "") for issue in issues)
        diagnostic: Diagnostic = {
            "severity": "error",
            "code": "schema-invalid",
            "message": joined or "Schema validation failed.",
            "fixture": fixture,
            "source": source,
            "path": path,
        }
        first_path = issues[0].get("path") if issues else None
        if first_path is not None:
            diagnostic["fieldPath"] = format_issue_path(first_path)
        super().__init__(diagnostic)
        self.issues: Sequence[SchemaIssue] = issues


def diagnostics_from_error(fixture: str | None, error: Exception) -> list[Diagnostic]:
    """Turn a raise into report-mode diagnostics.

    A validation error fans out to one diagnostic per issue; every other
    `FixtureError` contributes its own diagnostic, whose `fixture` wins over the
    contextual one; anything else becomes `unknown-error`.
    """
    if isinstance(error, FixtureValidationError):
        out: list[Diagnostic] = []
        for issue in error.issues:
            diagnostic: Diagnostic = {
                "severity": "error",
                "code": "schema-invalid",
                "message": issue.get("message", ""),
            }
            owner = error.diagnostic.get("fixture", fixture)
            if owner is not None:
                diagnostic["fixture"] = owner
            for key in ("source", "path"):
                value = error.diagnostic.get(key)
                if value is not None:
                    diagnostic[key] = value  # type: ignore[literal-required]
            issue_path = issue.get("path")
            if issue_path is not None:
                diagnostic["fieldPath"] = format_issue_path(issue_path)
            out.append(diagnostic)
        return out

    if isinstance(error, FixtureError):
        merged: Diagnostic = {"severity": "error", "code": "", "message": ""}
        if fixture is not None:
            merged["fixture"] = fixture
        merged.update(error.diagnostic)  # the diagnostic's own fixture wins
        return [merged]

    unknown: Diagnostic = {
        "severity": "error",
        "code": "unknown-error",
        "message": str(error),
    }
    if fixture:
        unknown["fixture"] = fixture
    return [unknown]


def format_issue_path(path: Sequence[Any]) -> str:
    """Dot-join a field path. Array indices render bare: `items.0.name`."""
    return ".".join(_segment_text(part) for part in path)


def _segment_text(part: Any) -> str:
    """Standard Schema allows either a bare key or a `{ key }` wrapper."""
    if isinstance(part, dict):
        wrapper = cast(dict[str, Any], part)
        if "key" in wrapper:
            return str(wrapper["key"])
    return str(cast(Any, part))
