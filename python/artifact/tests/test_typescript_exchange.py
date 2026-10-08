"""Exercise both public implementations against the same SQLite file and byte directory."""

from __future__ import annotations

import json
import subprocess
from pathlib import Path
from typing import Any

import pytest
from mirk.store import SqliteStore

from mirk.artifact import ArtifactCoordinator, ArtifactMaintenance
from mirk.artifact.fs import FileObjectStore
from mirk.artifact.store import StoreArtifactRepository

REPO = Path(__file__).resolve().parents[3]


@pytest.fixture(scope="module", autouse=True)
def build_typescript_artifact() -> None:
    for package in ("@mirk/store", "@mirk/artifact"):
        result = subprocess.run(
            ["pnpm", "--filter", package, "build"],
            cwd=REPO,
            capture_output=True,
            text=True,
            check=False,
        )
        assert result.returncode == 0, result.stdout + result.stderr


def node(script: str, *args: str) -> Any:
    imports = f"""
import {{ SqliteAdapter }} from
  {json.dumps((REPO / "packages/store/dist/adapters/sqlite.js").as_uri())};
import {{ toAsync }} from {json.dumps((REPO / "packages/store/dist/kv.js").as_uri())};
import {{ ArtifactCoordinator }} from
  {json.dumps((REPO / "packages/artifact/dist/index.js").as_uri())};
import {{ StoreArtifactRepository }} from
  {json.dumps((REPO / "packages/artifact/dist/store.js").as_uri())};
import {{ FileObjectStore }} from {json.dumps((REPO / "packages/artifact/dist/fs.js").as_uri())};
const [path, root, extra] = process.argv.slice(1);
const db = new SqliteAdapter({{path}});
const repository = new StoreArtifactRepository(toAsync(db.kv), {{
  namespace: 'exchange', now: () => 1000,
}});
const objects = new FileObjectStore({{root}});
let sequence = 0;
const artifacts = new ArtifactCoordinator(objects, repository, {{
  namespace: 'exchange', idFactory: () => `ts-${{++sequence}}`, now: () => 1000,
  concurrency: {{mode: 'repository-atomic'}},
}});
"""
    result = subprocess.run(
        ["node", "--input-type=module", "-e", imports + script, *args],
        cwd=REPO,
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    return json.loads(result.stdout.strip().splitlines()[-1])


def test_artifacts_reopen_replay_and_preserve_lineage_in_both_languages(tmp_path: Path) -> None:
    database, root = tmp_path / "exchange.sqlite", tmp_path / "objects"
    written = node(
        """
const source = await artifacts.write({
  bytes: new TextEncoder().encode('source'), mediaType: 'text/plain',
  idempotencyKey: 'ts/request',
});
const derived = await artifacts.write({
  bytes: new TextEncoder().encode('derived'), mediaType: 'text/plain',
  sources: [{artifactId: source.id, operation: 'derive'}],
});
console.log(JSON.stringify({source, derived, sources: await repository.getSources(derived.id)}));
db.close();
""",
        str(database),
        str(root),
    )

    with SqliteStore(str(database)) as store:
        repository = StoreArtifactRepository(store, namespace="exchange", now=lambda: 1_000)
        objects = FileObjectStore(str(root))
        ids = iter(["py-1", "py-2"])
        artifacts = ArtifactCoordinator(
            objects,
            repository,
            namespace="exchange",
            id_factory=lambda: next(ids),
            now=lambda: 1_000,
            concurrency={"mode": "repository-atomic"},
        )
        for descriptor in (written["source"], written["derived"]):
            assert artifacts.verify(descriptor["id"])["ok"] is True
            result = artifacts.read(descriptor["id"])
            assert result is not None
            assert result["artifact"] == descriptor
        source_read = artifacts.read(written["source"]["id"])
        assert source_read is not None
        assert b"".join(source_read["bytes"]) == b"source"
        assert repository.getSources(written["derived"]["id"]) == written["sources"]
        assert (
            artifacts.write(
                {
                    "bytes": b"source",
                    "mediaType": "text/plain",
                    "idempotencyKey": "ts/request",
                }
            )
            == written["source"]
        )
        python_record = artifacts.write(
            {
                "bytes": b"python result",
                "mediaType": "text/plain",
                "idempotencyKey": "py/request",
                "sources": [{"artifactId": written["derived"]["id"], "operation": "transform"}],
            }
        )
        python_sources = repository.getSources(python_record["id"])

    reopened = node(
        """
const request = JSON.parse(extra);
const read = await artifacts.read(request.id);
const chunks = [];
for await (const chunk of read.bytes) chunks.push(chunk);
const replayed = await artifacts.write({
  bytes: new TextEncoder().encode('python result'), mediaType: 'text/plain',
  idempotencyKey: 'py/request', sources: [{artifactId: request.sourceId, operation: 'transform'}],
});
console.log(JSON.stringify({
  artifact: read.artifact, bytes: Buffer.concat(chunks).toString('utf8'),
  verification: await artifacts.verify(request.id), replayed,
  sources: await repository.getSources(request.id),
}));
db.close();
""",
        str(database),
        str(root),
        json.dumps({"id": python_record["id"], "sourceId": written["derived"]["id"]}),
    )
    assert reopened["artifact"] == python_record
    assert reopened["bytes"] == "python result"
    assert reopened["verification"]["ok"] is True
    assert reopened["replayed"] == python_record
    assert reopened["sources"] == python_sources


def test_a_foreign_writer_lease_blocks_repair(tmp_path: Path) -> None:
    database, root = tmp_path / "leases.sqlite", tmp_path / "objects"
    with SqliteStore(str(database)) as store:
        repository = StoreArtifactRepository(
            store,
            namespace="exchange",
            now=lambda: 1_000,
            lease_id_factory=lambda: "py-lease",
        )
        objects = FileObjectStore(str(root))
        objects.put("orphan", b"source")
        maintenance = ArtifactMaintenance(objects, repository, now=lambda: 1_000)
        report = maintenance.audit()
        plan = maintenance.planRepair(report)
        acquired = node(
            """
const result = await repository.acquireObjectLease({
  objectKey: 'orphan', ownerId: 'ts-writer', mode: 'shared-writer',
});
console.log(JSON.stringify(result));
db.close();
""",
            str(database),
            str(root),
        )
        assert acquired["status"] == "acquired"
        result = maintenance.applyRepair(plan)
        assert result[0]["status"] == "conflict"
        assert result[0]["reason"] == "lease-unavailable"
        assert objects.head("orphan") is not None
        assert repository.releaseObjectLease(acquired["lease"]) is True
        assert maintenance.applyRepair(plan)[0]["status"] == "applied"
        assert objects.head("orphan") is None
