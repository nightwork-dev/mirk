from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path
from typing import Any, cast

import pytest
from mirk.store import SqliteStore

from mirk.artifact.coordinator import ArtifactCoordinator
from mirk.artifact.memory import InMemoryArtifactRepository, InMemoryObjectStore
from mirk.artifact.store import StoreArtifactRepository


@pytest.mark.parametrize("repository_kind", ["memory", "sqlite"])
@pytest.mark.parametrize("before_yield", [True, False])
@pytest.mark.parametrize("interrupt_type", [KeyboardInterrupt, SystemExit])
def test_write_interrupt_preserves_identity_and_cleans_owned_state(
    repository_kind: str,
    before_yield: bool,
    interrupt_type: type[BaseException],
    tmp_path: Path,
) -> None:
    objects = InMemoryObjectStore()
    database: SqliteStore | None = None
    if repository_kind == "memory":
        repository = InMemoryArtifactRepository(now=lambda: 1000)
    else:
        database = SqliteStore(str(tmp_path / "interrupts.sqlite"))
        repository = StoreArtifactRepository(database, now=lambda: 1000)

    interrupt = interrupt_type()

    def source() -> Iterator[bytes]:
        if not before_yield:
            yield b"partial"
        raise interrupt

    try:
        coordinator = ArtifactCoordinator(
            objects,
            repository,
            id_factory=lambda: "artifact-1",
            now=lambda: 1000,
            owner_id="writer",
            concurrency={"mode": "repository-atomic"},
        )
        with pytest.raises(interrupt_type) as caught:
            coordinator.write({"bytes": source(), "mediaType": "text/plain"})
        assert caught.value is interrupt
        assert repository.get("artifact-1") is None
        assert objects.head("artifacts/artifact-1") is None

        reacquired = repository.acquireObjectLease(
            objectKey="artifacts/artifact-1",
            ownerId="after",
            mode="exclusive-delete",
            ttlMs=1_000,
            now=1000,
        )
        assert reacquired["status"] == "acquired"
        assert repository.releaseObjectLease(reacquired["lease"]) is True
    finally:
        if database is not None:
            database.close()


@pytest.mark.parametrize("repository_kind", ["memory", "sqlite"])
def test_commit_interrupt_preserves_identity_and_rolls_back(
    repository_kind: str, tmp_path: Path
) -> None:
    objects = InMemoryObjectStore()
    database: SqliteStore | None = None
    if repository_kind == "memory":
        repository = InMemoryArtifactRepository(now=lambda: 1000)
    else:
        database = SqliteStore(str(tmp_path / "commit-interrupt.sqlite"))
        repository = StoreArtifactRepository(database, now=lambda: 1000)
    interrupt = KeyboardInterrupt("stop during commit")

    def raise_interrupt(_edge: Any) -> None:
        raise interrupt

    cast(Any, repository).addLineage = raise_interrupt
    try:
        coordinator = ArtifactCoordinator(
            objects,
            repository,
            id_factory=lambda: "artifact-1",
            now=lambda: 1000,
            owner_id="writer",
            concurrency={"mode": "repository-atomic"},
        )
        with pytest.raises(KeyboardInterrupt) as caught:
            coordinator.write(
                {
                    "bytes": b"payload",
                    "mediaType": "text/plain",
                    "sources": [{"artifactId": "source", "operation": "derive"}],
                }
            )
        assert caught.value is interrupt
        assert repository.get("artifact-1") is None
        assert objects.head("artifacts/artifact-1") is None
    finally:
        if database is not None:
            database.close()
