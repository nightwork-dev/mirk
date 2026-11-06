"""Keyed admission and indexed inspection over the existing lifecycle store."""

from typing import Any

from mirk.store.canonical import canonical_json

from .errors import JobsError
from .validation import validate_enqueue, validate_job


def terminal(job: dict[str, Any]) -> bool:
    return job["state"] in {"succeeded", "failed", "cancelled"}


class JobDiscovery:
    def _slot_key(self: Any, queue: str, key: str) -> str:
        return "mirk-jobs-active:" + canonical_json([self.collection, queue, key])

    def _slot_mutation(self: Any, job: dict[str, Any]) -> tuple[list[Any], list[Any]]:
        if job["activeKey"] is None:
            return [], []
        key = self._slot_key(job["queue"], job["activeKey"])
        target = {"kind": "key", "key": key}
        slot = self.store.getVersioned(target)
        if terminal(job):
            if slot and slot["value"] == job["id"]:
                return (
                    [{"target": target, "expected": "version", "version": slot["version"]}],
                    [{"op": "delete", "key": key}],
                )
            return [], []
        if slot:
            if not isinstance(slot["value"], str) or not slot["value"]:
                raise JobsError("invalid-input")
            if slot["value"] == job["id"]:
                return [], []
            other = self.get(slot["value"])
            if other and not terminal(other["value"]):
                raise JobsError("conflict")
        condition = (
            {"target": target, "expected": "version", "version": slot["version"]}
            if slot
            else {"target": target, "expected": "missing"}
        )
        return [condition], [{"op": "set", "key": key, "value": job["id"]}]

    def start(self: Any, input: dict[str, Any], command: dict[str, Any]) -> dict[str, Any]:
        import copy

        input = copy.deepcopy(input)
        candidate = {k: v for k, v in input.items() if k != "key"}
        validate_enqueue({**candidate, "id": candidate.get("id", "pending")})
        for field in ("key", "queue"):
            if not isinstance(input.get(field), str) or not input[field]:
                raise JobsError("invalid-input")
        if "id" in input and (not isinstance(input["id"], str) or not input["id"]):
            raise JobsError("invalid-input")
        for field in ("subject", "kind"):
            if field in input and not isinstance(input[field], str):
                raise JobsError("invalid-input")
        canonical_json(input["payload"])
        priority = input.get("priority", 0)
        if (
            isinstance(priority, bool)
            or not isinstance(priority, int)
            or abs(priority) > 9007199254740991
        ):
            raise JobsError("invalid-input")
        if "availableAt" in input:
            from .core import validate_time

            validate_time(input["availableAt"])

        def work() -> dict[str, Any]:
            pointer = self.store.get(self._slot_key(input["queue"], input["key"]))
            if pointer is not None:
                if not isinstance(pointer, str) or not pointer:
                    raise JobsError("invalid-input")
                existing = self.get(pointer)
                if existing and not terminal(existing["value"]):
                    if (
                        existing["value"]["queue"] != input["queue"]
                        or existing["value"]["activeKey"] != input["key"]
                    ):
                        raise JobsError("conflict")
                    return {"started": False, "job": existing}
            id = input.get("id") if "id" in input else self.token()
            if not isinstance(id, str) or not id:
                raise JobsError("invalid-input")
            return {"started": True, "job": self._create({**candidate, "id": id}, input["key"])}

        result: dict[str, Any] = self._command("start", input, command, work)
        return result

    def list(self: Any, filter: dict[str, Any] | None = None) -> list[dict[str, Any]]:
        from .core import validate_time

        filter = filter or {}
        if "limit" in filter:
            validate_time(filter["limit"])
        sort_by, sort_dir = filter.get("sortBy", "updatedAt"), filter.get("sortDir", "desc")
        if sort_by not in {"updatedAt", "enqueuedAt", "priority"} or sort_dir not in {
            "asc",
            "desc",
        }:
            raise JobsError("invalid-input")
        if not callable(getattr(self.store, "ensureIndex", None)):
            raise JobsError("invalid-input", "Job listing requires ensureIndex")
        with self.transactions.transaction():
            where = {k: filter[k] for k in ("queue", "subject", "kind", "state") if k in filter}
            for field in (*where, sort_by):
                self.store.ensureIndex(self.collection, field)
            query = {"where": where, "sortBy": sort_by, "sortDir": sort_dir}
            if "limit" in filter:
                query["limit"] = filter["limit"]
            records = self.store.list(self.collection, query)
            for job in records:
                validate_job(job)
            return [self._require(j["id"]) for j in records]
