from __future__ import annotations

import os
import uuid
from collections.abc import Iterator
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import NamedTuple

import opendal
import pytest
from mirk.artifact.coordinator import ArtifactCoordinator
from mirk.artifact.maintenance import ArtifactMaintenance
from mirk.artifact.memory import ObjectAlreadyExistsError
from mirk.artifact.store import StoreArtifactRepository
from mirk.store import SqliteStore

from mirk.artifact_opendal import OpenDalObjectStore


class S3Settings(NamedTuple):
    endpoint: str
    bucket: str
    access_key_id: str
    secret_access_key: str
    region: str


class S3Context(NamedTuple):
    settings: S3Settings
    root: str


@pytest.fixture(scope="session")
def s3_settings() -> S3Settings:
    endpoint = os.getenv("MIRK_OPENDAL_S3_ENDPOINT")
    if not endpoint:
        pytest.skip("set MIRK_OPENDAL_S3_ENDPOINT to run the S3 integration tests")
    names = (
        "MIRK_OPENDAL_S3_BUCKET",
        "MIRK_OPENDAL_S3_ACCESS_KEY_ID",
        "MIRK_OPENDAL_S3_SECRET_ACCESS_KEY",
    )
    values = {name: os.getenv(name) for name in names}
    missing = [name for name, value in values.items() if not value]
    if missing:
        pytest.fail(f"S3 integration requested but variables are missing: {', '.join(missing)}")
    bucket = values["MIRK_OPENDAL_S3_BUCKET"]
    access_key_id = values["MIRK_OPENDAL_S3_ACCESS_KEY_ID"]
    secret_access_key = values["MIRK_OPENDAL_S3_SECRET_ACCESS_KEY"]
    assert bucket is not None and access_key_id is not None and secret_access_key is not None
    return S3Settings(
        endpoint=endpoint,
        bucket=bucket,
        access_key_id=access_key_id,
        secret_access_key=secret_access_key,
        region=os.getenv("MIRK_OPENDAL_S3_REGION", "us-east-1"),
    )


def _operator(settings: S3Settings, root: str) -> opendal.Operator:
    return opendal.Operator(
        "s3",
        endpoint=settings.endpoint,
        bucket=settings.bucket,
        root=root,
        access_key_id=settings.access_key_id,
        secret_access_key=settings.secret_access_key,
        region=settings.region,
    )


def _store(context: S3Context, digest_metadata_key: str | None = None) -> OpenDalObjectStore:
    return OpenDalObjectStore(
        _operator(context.settings, context.root),
        digest_metadata_key=digest_metadata_key,
    )


@pytest.fixture
def s3_context(s3_settings: S3Settings) -> Iterator[S3Context]:
    context = S3Context(s3_settings, f"mirk-artifact-opendal-{uuid.uuid4().hex}")
    cleanup_store = _store(context)
    try:
        yield context
    finally:
        for info in cleanup_store.list(""):
            cleanup_store.delete(str(info["key"]))


def test_s3_roundtrip_metadata_and_list(s3_context: S3Context) -> None:
    objects = _store(s3_context, digest_metadata_key="sha256")
    unicode_key = "artifacts/nonascii/é-😀"
    unicode_info = objects.put(
        unicode_key,
        b"unicode",
        {
            "ifAbsent": True,
            "mediaType": "text/plain",
            "metadata": {"origin": "integration"},
        },
    )
    assert unicode_info.get("metadata", {}).get("origin") == "integration"
    assert unicode_info["sizeBytes"] == len(b"unicode")

    unicode_head = objects.head(unicode_key)
    assert unicode_head is not None
    assert unicode_head.get("digest", {}).get("algorithm") == "sha256"
    assert b"".join(objects.get(unicode_key) or []) == b"unicode"

    objects.put("artifacts/list/b", b"b", {"ifAbsent": True})
    objects.put("artifacts/list/a", b"a", {"ifAbsent": True})
    objects.put("other", b"other", {"ifAbsent": True})
    listed = objects.list("artifacts/list/")
    assert [info["key"] for info in listed] == ["artifacts/list/a", "artifacts/list/b"]
    assert all(str(info["key"]).startswith("artifacts/list/") for info in listed)
    assert [info["key"] for info in objects.list("artifacts/list/a")] == ["artifacts/list/a"]

    reopened = _store(s3_context, digest_metadata_key="sha256")
    assert b"".join(reopened.get(unicode_key) or []) == b"unicode"

    # S3 multipart uploads use a documented 5 MiB minimum part size.
    multipart_size = 5 * 1024 * 1024 + 1
    multipart_info = objects.put(
        "artifacts/multipart",
        b"m" * multipart_size,
        {"ifAbsent": True, "mediaType": "application/octet-stream"},
    )
    assert multipart_info["sizeBytes"] == multipart_size


@pytest.mark.parametrize("before_yield", [True, False])
@pytest.mark.parametrize("preexisting", [True, False])
def test_s3_source_failures_preserve_conflicts_and_clean_owned_objects(
    s3_context: S3Context, before_yield: bool, preexisting: bool
) -> None:
    objects = _store(s3_context)
    key = f"artifacts/failure-{before_yield}-{preexisting}"
    if preexisting:
        objects.put(key, b"existing", {"ifAbsent": True})

    def failing() -> Iterator[bytes]:
        if not before_yield:
            yield b"replacement"
        raise RuntimeError("source failed")

    expected = ObjectAlreadyExistsError if preexisting else RuntimeError
    with pytest.raises(expected):
        objects.put(key, failing(), {"ifAbsent": True})
    if preexisting:
        assert b"".join(objects.get(key) or []) == b"existing"
    else:
        objects.put(key, b"retry", {"ifAbsent": True})
        assert b"".join(objects.get(key) or []) == b"retry"


def test_s3_if_absent_race_has_one_winner(s3_context: S3Context) -> None:
    objects = _store(s3_context)
    race_key = "artifacts/race"

    def race_write(client: OpenDalObjectStore, value: bytes) -> str:
        try:
            client.put(race_key, value, {"ifAbsent": True})
            return "won"
        except ObjectAlreadyExistsError:
            return "conflict"

    clients = [_store(s3_context), _store(s3_context)]
    with ThreadPoolExecutor(max_workers=2) as pool:
        outcomes = list(pool.map(race_write, clients, [b"winner-a", b"winner-b"]))
    assert sorted(outcomes) == ["conflict", "won"]
    assert b"".join(objects.get(race_key) or []) in {b"winner-a", b"winner-b"}


def test_s3_coordinator_and_maintenance(s3_context: S3Context, tmp_path: Path) -> None:
    objects = _store(s3_context, digest_metadata_key="sha256")
    namespace = "artifacts"
    with SqliteStore(str(tmp_path / "metadata.sqlite")) as store:
        repository = StoreArtifactRepository(store, namespace=namespace)
        artifacts = ArtifactCoordinator(
            objects,
            repository,
            namespace=namespace,
            id_factory=lambda: f"artifact-{uuid.uuid4().hex}",
            concurrency={"mode": "repository-atomic"},
        )
        artifact = artifacts.write(
            {
                "bytes": [b"s3", b" artifact"],
                "mediaType": "text/plain",
                "idempotencyKey": "s3-lifecycle",
            }
        )
        replay = artifacts.write(
            {
                "bytes": b"s3 artifact",
                "mediaType": "text/plain",
                "idempotencyKey": "s3-lifecycle",
            }
        )
        assert replay == artifact
        assert artifacts.verify(artifact["id"])["ok"] is True
        read = artifacts.read(artifact["id"])
        assert read is not None
        assert b"".join(read["bytes"]) == b"s3 artifact"
        assert repository.list()["items"]

        orphan = f"{namespace}/orphan"
        objects.put(orphan, b"orphan", {"ifAbsent": True})
        maintenance = ArtifactMaintenance(objects, repository)
        report = maintenance.audit()
        plan = maintenance.planRepair(report)
        results = maintenance.applyRepair(plan)
        assert any(result["status"] == "applied" for result in results)
        assert objects.head(orphan) is None
        assert artifacts.delete(artifact["id"]) is True
