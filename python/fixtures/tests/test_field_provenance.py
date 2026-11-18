from typing import Any

from helpers import loader, memory, registry


def test_schema_mutations_have_no_authored_origin() -> None:
    def mutate(value: Any) -> Any:
        value["a"] = 2
        return {"value": value}

    fixtures = loader(
        registry({"type": "thing", "directory": "things", "schema": mutate}),
        [memory("base", {"things/a.json": '{"a":1}'})],
    )
    loaded = fixtures.loadRaw("thing:a")
    assert loaded["value"] == {"a": 2}
    assert loaded["provenance"]["fields"] == {}
