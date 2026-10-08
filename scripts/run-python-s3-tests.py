#!/usr/bin/env python3
"""Run the Python S3 artifact adapter against a real local MinIO server.

The service lifecycle is owned by this process. Docker is deliberately not
used. Set ``MINIO_BINARY`` to a reviewed, pinned binary in CI; when it is not
set, this script builds the pinned official MinIO source tag with Go into a
temporary cache. The tag is the last upstream release published before the
official repository was archived.

Primary references:
* https://min.io/docs/minio/linux/reference/minio-server/minio-server.html
* https://github.com/minio/minio/releases/tag/RELEASE.2025-10-15T17-29-55Z
* https://github.com/minio/minio/blob/master/Dockerfile.release

The adapter tests run from ``python/artifact-opendal`` through the declared
Python workspace package. Set ``MIRK_S3_PYTHON`` to a fresh wheel-installed
interpreter to bypass uv and run ``python -I -m pytest`` directly; the harness
rejects editable/source imports in that mode.
"""

from __future__ import annotations

import hashlib
import json
import os
import secrets
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path
from shlex import split as shell_split

MINIO_VERSION = "RELEASE.2025-10-15T17-29-55Z"
MINIO_COMMIT = "9e49d5e7a648"
MINIO_MODULE = f"github.com/minio/minio@{MINIO_VERSION}"
PACKAGE_NAME = "mirk-artifact-opendal"
HEALTH_PATH = "/minio/health/live"
WAIT_SECONDS = 45.0


def main() -> int:
    root = Path(__file__).resolve().parents[1]
    package_root = root / "python" / "artifact-opendal"
    if not package_root.is_dir():
        raise RuntimeError(f"missing Python package directory: {package_root}")
    data_dir = Path(tempfile.mkdtemp(prefix="mirk-minio-data-"))
    cache_dir = Path(tempfile.mkdtemp(prefix="mirk-minio-cache-"))
    process: subprocess.Popen[str] | None = None
    log_handle = None
    try:
        binary = acquire_minio(cache_dir)
        api_port = free_port()
        console_port = free_port()
        access_key = "mirk-test-" + secrets.token_hex(8)
        secret_key = secrets.token_urlsafe(32)
        bucket = "mirk-artifacts-test"
        endpoint = f"http://127.0.0.1:{api_port}"

        environment = {
            **sanitized_environment(),
            "MINIO_ROOT_USER": access_key,
            "MINIO_ROOT_PASSWORD": secret_key,
        }
        log_path = data_dir / "minio.log"
        log_handle = log_path.open("w", encoding="utf-8")
        process = subprocess.Popen(
            [
                str(binary),
                "server",
                str(data_dir / "objects"),
                "--address",
                f"127.0.0.1:{api_port}",
                "--console-address",
                f"127.0.0.1:{console_port}",
            ],
            cwd=root,
            env=environment,
            stdout=log_handle,
            stderr=subprocess.STDOUT,
            text=True,
        )
        wait_for_health(endpoint, process, log_path)

        test_environment = make_test_environment(
            endpoint=endpoint,
            access_key=access_key,
            secret_key=secret_key,
            bucket=bucket,
        )
        python_interpreter = configured_python()
        assert_wheel_imports(package_root, test_environment, python_interpreter)
        bootstrap_bucket(
            package_root,
            test_environment,
            endpoint,
            access_key,
            secret_key,
            bucket,
            python_interpreter,
        )
        junit_path = data_dir / "pytest.xml"
        result = run_adapter_tests(package_root, test_environment, junit_path, python_interpreter)
        test_counts = read_test_counts(junit_path)
        if test_counts["tests"] == 0 or test_counts["skipped"] > 0:
            raise RuntimeError(f"S3 test suite did not execute cleanly: {test_counts}")
        if test_counts["integrationTests"] == 0:
            raise RuntimeError(
                "S3 test suite did not execute an integration testcase: "
                f"{test_counts}"
            )
        if test_counts["errors"] or test_counts["failures"]:
            raise RuntimeError(f"S3 test suite failed: {test_counts}")
        print(
            json.dumps(
                {
                    "minioVersion": MINIO_VERSION,
                    "binary": str(binary),
                    "endpoint": endpoint,
                    "bucket": bucket,
                    "testReturnCode": result.returncode,
                    "tests": test_counts,
                },
                sort_keys=True,
            )
        )
        return result.returncode
    finally:
        if process is not None:
            stop_process(process)
        if log_handle is not None:
            log_handle.close()
        shutil.rmtree(data_dir, ignore_errors=True)
        shutil.rmtree(cache_dir, ignore_errors=True)


def acquire_minio(cache_dir: Path) -> Path:
    configured = os.environ.get("MINIO_BINARY")
    if configured:
        binary = Path(configured).expanduser().resolve()
        if not binary.is_file() or not os.access(binary, os.X_OK):
            raise RuntimeError(f"MINIO_BINARY is not an executable file: {binary}")
    else:
        go = shutil.which("go")
        if go is None:
            raise RuntimeError(
                "MINIO_BINARY is required when Go is unavailable; "
                f"expected pinned MinIO source tag {MINIO_VERSION}"
            )
        cache_dir.mkdir(parents=True, exist_ok=True)
        subprocess.run(
            [
                go,
                "install",
                "-ldflags",
                (
                    f"-X github.com/minio/minio/cmd.ReleaseTag={MINIO_VERSION} "
                    f"-X github.com/minio/minio/cmd.Version={MINIO_VERSION} "
                    f"-X github.com/minio/minio/cmd.CommitID={MINIO_COMMIT} "
                    f"-X github.com/minio/minio/cmd.ShortCommitID={MINIO_COMMIT}"
                ),
                MINIO_MODULE,
            ],
            check=True,
            env={**os.environ, "GOBIN": str(cache_dir), "CGO_ENABLED": "0"},
        )
        binary = cache_dir / "minio"

    version_run = subprocess.run(
        [str(binary), "--version"],
        check=True,
        capture_output=True,
        text=True,
    )
    version = version_run.stdout + version_run.stderr
    if MINIO_VERSION not in version:
        raise RuntimeError(
            f"MinIO binary version mismatch: expected {MINIO_VERSION}, got {version.strip()}"
        )
    expected_sha256 = os.environ.get("MINIO_SHA256")
    if expected_sha256:
        digest = hashlib.sha256(binary.read_bytes()).hexdigest()
        if digest.lower() != expected_sha256.lower():
            raise RuntimeError(
                f"MinIO binary checksum mismatch: expected {expected_sha256}, got {digest}"
            )
    return binary


def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def wait_for_health(endpoint: str, process: subprocess.Popen[str], log_path: Path) -> None:
    deadline = time.monotonic() + WAIT_SECONDS
    url = endpoint + HEALTH_PATH
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError(f"MinIO exited with code {process.returncode}: {log_path.read_text()}")
        try:
            with urllib.request.urlopen(url, timeout=1) as response:
                if response.status == 200:
                    return
        except (urllib.error.URLError, TimeoutError, ConnectionError):
            time.sleep(0.1)
    raise RuntimeError(f"MinIO did not become healthy; log:\n{log_path.read_text()}")


def make_test_environment(
    *, endpoint: str, access_key: str, secret_key: str, bucket: str
) -> dict[str, str]:
    return {
        **sanitized_environment(),
        "MIRK_OPENDAL_S3_ENDPOINT": endpoint,
        "MIRK_OPENDAL_S3_BUCKET": bucket,
        "MIRK_OPENDAL_S3_ACCESS_KEY_ID": access_key,
        "MIRK_OPENDAL_S3_SECRET_ACCESS_KEY": secret_key,
        "MIRK_OPENDAL_S3_REGION": "us-east-1",
        "AWS_EC2_METADATA_DISABLED": "TRUE",
    }


def configured_python() -> Path | None:
    configured = os.environ.get("MIRK_S3_PYTHON")
    if not configured:
        return None
    # Resolving the symlink would bypass the virtual environment's pyvenv.cfg.
    interpreter = Path(os.path.abspath(os.path.expanduser(configured)))
    if not interpreter.is_file() or not os.access(interpreter, os.X_OK):
        raise RuntimeError(f"MIRK_S3_PYTHON is not an executable file: {interpreter}")
    return interpreter


def sanitized_environment() -> dict[str, str]:
    blocked_prefixes = (
        "AWS_",
        "MINIO_",
        "MIRK_S3_",
        "MIRK_ARTIFACT_S3_",
        "MIRK_OPENDAL_S3_",
        "S3_",
    )
    return {
        key: value
        for key, value in os.environ.items()
        if not key.startswith(blocked_prefixes)
    }


def bootstrap_bucket(
    package_root: Path,
    environment: dict[str, str],
    endpoint: str,
    access_key: str,
    secret_key: str,
    bucket: str,
    python_interpreter: Path | None,
) -> None:
    workspace_root = package_root.parent
    code = """
import boto3
import sys

client = boto3.client(
    "s3",
    endpoint_url=sys.argv[1],
    aws_access_key_id=sys.argv[2],
    aws_secret_access_key=sys.argv[3],
    region_name=sys.argv[4],
)
bucket = sys.argv[5]
try:
    client.head_bucket(Bucket=bucket)
except Exception:
    client.create_bucket(Bucket=bucket)
client.head_bucket(Bucket=bucket)
"""
    if python_interpreter is not None:
        command = [
            str(python_interpreter), "-I", "-c", code,
            endpoint, access_key, secret_key, "us-east-1", bucket,
        ]
        cwd = package_root
    else:
        command = [
            "uv", "run", "--project", str(workspace_root), "--package", PACKAGE_NAME,
            "--locked", "--group", "dev", "--with", "boto3", "python", "-c", code,
            endpoint, access_key, secret_key, "us-east-1", bucket,
        ]
        cwd = workspace_root
    run = subprocess.run(command, cwd=cwd, env=environment, text=True, check=False)
    if run.returncode != 0:
        raise RuntimeError(f"boto3 bucket bootstrap failed with code {run.returncode}")


def run_adapter_tests(
    package_root: Path,
    environment: dict[str, str],
    junit_path: Path,
    python_interpreter: Path | None,
) -> subprocess.CompletedProcess[str]:
    workspace_root = package_root.parent
    extra_args = shell_split(os.environ.get("MIRK_S3_TEST_ARGS", ""))
    if python_interpreter is not None:
        command = [
            str(python_interpreter), "-I", "-m", "pytest", "-q",
            f"--junitxml={junit_path}", str(package_root / "tests"), *extra_args,
        ]
    else:
        command = [
            "uv", "run", "--project", str(workspace_root), "--package", PACKAGE_NAME,
            "--locked", "--group", "dev", "pytest", "-q",
            f"--junitxml={junit_path}", *extra_args,
        ]
    return subprocess.run(command, cwd=package_root, env=environment, text=True, check=False)


def assert_wheel_imports(
    package_root: Path, environment: dict[str, str], python_interpreter: Path | None
) -> None:
    if python_interpreter is None:
        return
    code = """
import importlib
names = ("mirk.artifact_opendal", "mirk.artifact", "mirk.store")
bad = []
for name in names:
    module = importlib.import_module(name)
    origin = getattr(module, "__file__", "") or ""
    if "site-packages" not in origin:
        bad.append(f"{name}={origin}")
if bad:
    raise SystemExit("wheel import check failed: " + ", ".join(bad))
"""
    result = subprocess.run(
        [str(python_interpreter), "-I", "-c", code],
        cwd=package_root,
        env=environment,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        raise RuntimeError("MIRK_S3_PYTHON must import installed wheels from site-packages")


def read_test_counts(junit_path: Path) -> dict[str, int]:
    if not junit_path.is_file():
        raise RuntimeError(f"pytest did not produce JUnit XML: {junit_path}")
    root = ET.parse(junit_path).getroot()
    suites = [root] if root.tag == "testsuite" else list(root.findall("testsuite"))
    counts = {
        "tests": 0,
        "failures": 0,
        "errors": 0,
        "skipped": 0,
        "integrationTests": 0,
    }
    for suite in suites:
        for name in ("tests", "failures", "errors", "skipped"):
            counts[name] += int(suite.attrib.get(name, "0"))
    counts["integrationTests"] = sum(
        1
        for testcase in root.iter("testcase")
        if "test_s3_integration" in testcase.attrib.get("classname", "")
    )
    return counts


def stop_process(process: subprocess.Popen[str]) -> None:
    if process.poll() is not None:
        return
    try:
        process.send_signal(signal.SIGTERM)
        process.wait(timeout=10)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=10)


if __name__ == "__main__":
    if "--help" in sys.argv:
        print(
            "Runs mirk-artifact-opendal Python tests against a temporary local "
            "MinIO server. Env: MINIO_BINARY, MINIO_SHA256, MIRK_S3_PYTHON, "
            "MIRK_S3_TEST_ARGS."
        )
        raise SystemExit(0)
    raise SystemExit(main())
