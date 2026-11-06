"""Real-process worker for mixed-language job storage tests."""

import json
import sys

from mirk.store.sqlite import SqliteStore
from mirk.store.transaction import SqliteTransactions

from mirk.jobs import JobsStore

path, action, id, key = sys.argv[1:]
store = SqliteStore(path)
jobs = JobsStore(store=store, transactions=SqliteTransactions(store), now=lambda: 100)
try:
    if action == "claim":
        result = jobs.claim(id, {"key": key, "leaseMs": 50})
    elif action == "complete":
        job = jobs.get(id)
        assert job is not None
        value = job["value"]
        claim = {"jobId": id, "ownerToken": value["ownerToken"], "generation": value["generation"]}
        jobs.checkpoint(claim, {"providerId": "python-provider"}, {"key": key + "-checkpoint"})
        result = jobs.complete(claim, {"artifactId": "python-output"}, {"key": key})["value"]
    elif action == "enqueue":
        result = jobs.enqueue(
            {"id": id, "queue": "q", "payload": {"source": "python"}}, {"key": key}
        )["value"]
    else:
        job = jobs.get(id)
        result = job["value"] if job else None
    print(json.dumps(result))
finally:
    store.close()
