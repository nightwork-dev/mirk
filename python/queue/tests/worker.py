"""Real-process worker for mixed-language item storage tests."""

import json
import sys

from mirk.store.sqlite import SqliteStore
from mirk.store.transaction import SqliteTransactions

from mirk.queue import QueueStore

path, action, id, key = sys.argv[1:]
store = SqliteStore(path)
queue = QueueStore(store=store, transactions=SqliteTransactions(store), now=lambda: 100)
try:
    if action == "start":
        result = queue.start(
            {"id": id, "queue": "q", "key": "shared", "payload": None}, {"key": key}
        )
    elif action == "claim":
        result = queue.claim(id, {"key": key, "leaseMs": 50})
    elif action == "complete":
        item = queue.get(id)
        assert item is not None
        value = item["value"]
        claim = {"itemId": id, "ownerToken": value["ownerToken"], "generation": value["generation"]}
        queue.checkpoint(claim, {"providerId": "python-provider"}, {"key": key + "-checkpoint"})
        result = queue.complete(claim, {"artifactId": "python-output"}, {"key": key})["value"]
    elif action == "enqueue":
        result = queue.enqueue(
            {"id": id, "queue": "q", "payload": {"source": "python"}}, {"key": key}
        )["value"]
    else:
        item = queue.get(id)
        result = item["value"] if item else None
    print(json.dumps(result))
finally:
    store.close()
