from collections.abc import Callable, Iterable
from typing import Any, cast

from .layering import pointer_part
from .types import FixtureFieldProvenance, FixtureProvenanceLayer


def field_recorder(
    fields: dict[str, FixtureFieldProvenance], layer: FixtureProvenanceLayer, prefix: str
) -> Callable[[str, Any], None]:
    def replace(path: str, value: Any) -> None:
        for key in list(fields):
            if (path == "" or key == path or key.startswith(path + "/")
                    or path.startswith(key + "/")):
                del fields[key]

        def record(value: Any, path: str) -> None:
            fields[path] = {**layer, "fieldPath": prefix + path}
            entries: Iterable[tuple[int | str, Any]] = ()
            if isinstance(value, list):
                entries = enumerate(cast(list[Any], value))
            elif isinstance(value, dict):
                entries = cast(dict[str, Any], value).items()
            for key, child in entries:
                record(child, path + "/" + pointer_part(str(key)))

        record(value, path)

    return replace


def field_snapshot(value: Any) -> str | None:
    import json

    try:
        return json.dumps(value, sort_keys=True)
    except (TypeError, ValueError):
        return None
