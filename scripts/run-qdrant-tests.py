#!/usr/bin/env python3
"""Run both vector adapters against a temporary native Qdrant server.

The server is the pinned Qdrant release, downloaded from its official GitHub
release only when ``QDRANT_BINARY`` is not set.  The process, configuration,
storage, and logs all live under one temporary directory owned by this run.
"""

from __future__ import annotations

import hashlib
import json
import os
import platform
import shutil
import signal
import socket
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path

QDRANT_VERSION = "1.19.2"
RELEASE_BASE_URL = (
    "https://github.com/qdrant/qdrant/releases/download/"
    f"v{QDRANT_VERSION}"
)
WAIT_SECONDS = 60.0
TS_PACKAGE = "@mirk/vector-qdrant"

# These are the official release archives and SHA-256 values for the four
# platforms supported by this harness.  Keep the table explicit so a new
# release cannot be fetched accidentally by changing only the version string.
RELEASES: dict[tuple[str, str], tuple[str, str]] = {
    (
        "Darwin",
        "arm64",
    ): (
        "qdrant-aarch64-apple-darwin.tar.gz",
        "d24dfd25f4584684b337dd30ee016472cd25f53fc2501f1cd058ab3d7ee0b019",
    ),
    (
        "Darwin",
        "x86_64",
    ): (
        "qdrant-x86_64-apple-darwin.tar.gz",
        "e095b682ad7460baff43827eaa13647b5ec97c48edcb676646ae2f4108395044",
    ),
    (
        "Linux",
        "x86_64",
    ): (
        "qdrant-x86_64-unknown-linux-musl.tar.gz",
        "50b253243309ed0ae50a19f678f0d0adcc4f0b567b3bd2c5c0c7e02fa8404bb6",
    ),
    (
        "Linux",
        "aarch64",
    ): (
        "qdrant-aarch64-unknown-linux-musl.tar.gz",
        "6970b93b56fa1203f0cea47d2f330fdb654988fd56617aa77e8478cffd3c0ccb",
    ),
}


def main() -> int:
    root = Path(__file__).resolve().parents[1]
    ts_package_root = root / "packages" / "vector-qdrant"
    python_package_root = root / "python" / "vector-qdrant"
    if not ts_package_root.is_dir():
        raise RuntimeError(f"missing TypeScript package directory: {ts_package_root}")
    if not python_package_root.is_dir():
        raise RuntimeError(f"missing Python package directory: {python_package_root}")

    with tempfile.TemporaryDirectory(prefix="mirk-qdrant-") as temporary_root:
        temporary_dir = Path(temporary_root)
        process: subprocess.Popen[str] | None = None
        log_handle = None
        try:
            binary = acquire_qdrant_binary(temporary_dir)
            http_port = free_port()
            endpoint = f"http://127.0.0.1:{http_port}"
            storage_dir = temporary_dir / "storage"
            storage_dir.mkdir()
            config_path = temporary_dir / "qdrant.yaml"
            config_path.write_text(
                qdrant_config(storage_dir, http_port), encoding="utf-8"
            )
            log_path = temporary_dir / "qdrant.log"
            log_handle = log_path.open("w", encoding="utf-8")

            process = start_qdrant(
                binary=binary,
                config_path=config_path,
                temporary_dir=temporary_dir,
                http_port=http_port,
                log_handle=log_handle,
            )
            wait_for_ready(endpoint, process, log_path)

            test_environment = test_environment_for(endpoint)
            ts_counts = run_typescript_tests(root, test_environment, temporary_dir)
            python_counts = run_python_tests(
                python_package_root, test_environment, temporary_dir
            )
            interpreter = configured_python()
            exchange_environment = dict(test_environment)
            if interpreter is not None:
                exchange_environment["MIRK_QDRANT_PYTHON"] = str(interpreter)
            subprocess.run(
                ["node", str(root / "scripts/qdrant-exchange.mjs")],
                cwd=root,
                env=exchange_environment,
                check=True,
            )
            print(
                json.dumps(
                    {
                        "qdrantVersion": QDRANT_VERSION,
                        "binary": str(binary),
                        "endpoint": endpoint,
                        "typescript": ts_counts,
                        "python": python_counts,
                        "crossLanguageExchange": True,
                    },
                    sort_keys=True,
                )
            )
            return 0
        finally:
            if process is not None:
                stop_process(process)
            if log_handle is not None:
                log_handle.close()


def acquire_qdrant_binary(temporary_dir: Path) -> Path:
    configured = os.environ.get("QDRANT_BINARY")
    if configured:
        binary = Path(os.path.abspath(os.path.expanduser(configured)))
        validate_qdrant_binary(binary)
        return binary

    system = platform.system()
    machine = normalize_machine(system, platform.machine())
    release = RELEASES.get((system, machine))
    if release is None:
        supported = ", ".join(f"{system}/{machine}" for system, machine in RELEASES)
        raise RuntimeError(
            f"unsupported Qdrant platform {system}/{platform.machine()}; "
            f"supported platforms: {supported}"
        )
    asset, expected_sha256 = release
    archive_path = temporary_dir / asset
    download_release(RELEASE_BASE_URL + "/" + asset, archive_path, expected_sha256)
    binary = temporary_dir / "qdrant"
    extract_binary(archive_path, binary)
    validate_qdrant_binary(binary)
    return binary


def normalize_machine(system: str, machine: str) -> str:
    if machine == "amd64":
        return "x86_64"
    if system == "Darwin" and machine == "aarch64":
        return "arm64"
    if system == "Linux" and machine == "arm64":
        return "aarch64"
    return machine


def download_release(url: str, destination: Path, expected_sha256: str) -> None:
    request = urllib.request.Request(url, headers={"User-Agent": "mirk-qdrant-tests"})
    try:
        with urllib.request.urlopen(request, timeout=120) as response, destination.open(
            "wb"
        ) as output:
            shutil.copyfileobj(response, output)
    except urllib.error.URLError as error:
        raise RuntimeError(f"failed to download Qdrant release {url}: {error}") from error
    digest = sha256(destination)
    if digest != expected_sha256:
        raise RuntimeError(
            f"Qdrant release checksum mismatch: expected {expected_sha256}, got {digest}"
        )


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def extract_binary(archive_path: Path, destination: Path) -> None:
    with tarfile.open(archive_path, mode="r:gz") as archive:
        candidates = [
            member
            for member in archive.getmembers()
            if member.isfile() and Path(member.name).name == "qdrant"
        ]
        if len(candidates) != 1:
            raise RuntimeError(
                "Qdrant archive must contain exactly one regular qdrant binary; "
                f"found {len(candidates)}"
            )
        source = archive.extractfile(candidates[0])
        if source is None:
            raise RuntimeError("Qdrant archive binary could not be read")
        with source, destination.open("wb") as output:
            shutil.copyfileobj(source, output)
    destination.chmod(0o755)


def validate_qdrant_binary(binary: Path) -> None:
    if not binary.is_file() or not os.access(binary, os.X_OK):
        raise RuntimeError(f"QDRANT_BINARY is not an executable file: {binary}")
    version = subprocess.run(
        [str(binary), "--version"],
        check=False,
        capture_output=True,
        text=True,
    )
    output = (version.stdout + version.stderr).strip()
    if version.returncode != 0 or QDRANT_VERSION not in output:
        raise RuntimeError(
            f"Qdrant binary version mismatch: expected {QDRANT_VERSION}, got {output!r}"
        )


def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def yaml_scalar(value: Path | str) -> str:
    return "'" + str(value).replace("'", "''") + "'"


def qdrant_config(storage_dir: Path, http_port: int) -> str:
    return "\n".join(
        [
            "service:",
            "  host: '127.0.0.1'",
            f"  http_port: {http_port}",
            "  grpc_port: null",
            "storage:",
            f"  storage_path: {yaml_scalar(storage_dir)}",
            "telemetry_disabled: true",
            "",
        ]
    )


def start_qdrant(
    *,
    binary: Path,
    config_path: Path,
    temporary_dir: Path,
    http_port: int,
    log_handle,
) -> subprocess.Popen[str]:
    environment = {
        **sanitized_environment(),
        "QDRANT__SERVICE__HOST": "127.0.0.1",
        "QDRANT__SERVICE__HTTP_PORT": str(http_port),
        "QDRANT__TELEMETRY_DISABLED": "true",
    }
    return subprocess.Popen(
        [str(binary), "--config-path", str(config_path)],
        cwd=temporary_dir,
        env=environment,
        stdout=log_handle,
        stderr=subprocess.STDOUT,
        text=True,
        start_new_session=True,
    )


def sanitized_environment() -> dict[str, str]:
    # The adapter tests must always use the endpoint owned by this process.
    # Removing all Qdrant-prefixed variables also prevents a user's cloud
    # credentials or alternate endpoint from changing service configuration.
    return {
        key: value
        for key, value in os.environ.items()
        if not key.startswith("QDRANT_") and not key.startswith("MIRK_QDRANT_")
    }


def test_environment_for(endpoint: str) -> dict[str, str]:
    return {
        **sanitized_environment(),
        "MIRK_QDRANT_URL": endpoint,
        "MIRK_CONFORMANCE_DIR": str(Path(__file__).resolve().parents[1] / "conformance"),
    }


def wait_for_ready(
    endpoint: str, process: subprocess.Popen[str], log_path: Path
) -> None:
    deadline = time.monotonic() + WAIT_SECONDS
    request = urllib.request.Request(endpoint + "/readyz")
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError(
                f"Qdrant exited with code {process.returncode}; log:\n{read_log(log_path)}"
            )
        try:
            with urllib.request.urlopen(request, timeout=1) as response:
                if response.status == 200:
                    return
        except (urllib.error.URLError, TimeoutError, ConnectionError):
            time.sleep(0.1)
    raise RuntimeError(f"Qdrant did not become ready; log:\n{read_log(log_path)}")


def read_log(log_path: Path) -> str:
    try:
        contents = log_path.read_text(encoding="utf-8", errors="replace")
    except OSError as error:
        return f"<unable to read log: {error}>"
    return contents[-12000:]


def run_typescript_tests(
    root: Path, environment: dict[str, str], temporary_dir: Path
) -> dict[str, int]:
    junit_path = temporary_dir / "typescript-junit.xml"
    command = [
        "pnpm",
        "--filter",
        TS_PACKAGE,
        "exec",
        "vitest",
        "run",
        "--reporter=default",
        "--reporter=junit",
        f"--outputFile={junit_path}",
    ]
    result = subprocess.run(command, cwd=root, env=environment, text=True, check=False)
    counts = read_junit_counts(junit_path)
    require_clean_tests("TypeScript Qdrant", result, counts)
    return counts


def run_python_tests(
    package_root: Path,
    environment: dict[str, str],
    temporary_dir: Path,
) -> dict[str, int]:
    junit_path = temporary_dir / "python-junit.xml"
    interpreter = configured_python()
    if interpreter is not None:
        assert_installed_python(package_root, environment, interpreter)
        command = [
            str(interpreter),
            "-I",
            "-m",
            "pytest",
            "-q",
            f"--junitxml={junit_path}",
            str(package_root / "tests"),
        ]
        cwd = package_root
    else:
        command = [
            "uv",
            "run",
            "--project",
            str(package_root),
            "--all-packages",
            "--locked",
            "pytest",
            "-q",
            f"--junitxml={junit_path}",
            str(package_root / "tests"),
        ]
        cwd = package_root
    result = subprocess.run(command, cwd=cwd, env=environment, text=True, check=False)
    counts = read_junit_counts(junit_path)
    require_clean_tests("Python Qdrant", result, counts)
    return counts


def assert_installed_python(
    package_root: Path, environment: dict[str, str], interpreter: Path
) -> None:
    code = """
import importlib

names = ("mirk.store", "mirk.vector_qdrant")
bad = []
for name in names:
    module = importlib.import_module(name)
    origin = getattr(module, "__file__", "") or ""
    if "site-packages" not in origin:
        bad.append(f"{name}={origin}")
if bad:
    raise SystemExit("installed Qdrant test imports required: " + ", ".join(bad))
"""
    result = subprocess.run(
        [str(interpreter), "-I", "-c", code],
        cwd=package_root,
        env=environment,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        raise RuntimeError(
            "MIRK_QDRANT_PYTHON must import mirk.store and mirk.vector_qdrant "
            "from site-packages"
        )


def configured_python() -> Path | None:
    configured = os.environ.get("MIRK_QDRANT_PYTHON")
    if not configured:
        return None
    # Keep the virtualenv's lexical interpreter path. Resolving it can bypass
    # pyvenv.cfg and silently run the system interpreter under ``-I``.
    interpreter = Path(os.path.abspath(os.path.expanduser(configured)))
    if not interpreter.is_file() or not os.access(interpreter, os.X_OK):
        raise RuntimeError(f"MIRK_QDRANT_PYTHON is not an executable file: {interpreter}")
    return interpreter


def read_junit_counts(junit_path: Path) -> dict[str, int]:
    if not junit_path.is_file():
        raise RuntimeError(f"adapter tests did not produce JUnit XML: {junit_path}")
    root = ET.parse(junit_path).getroot()
    suites = [root] if root.tag == "testsuite" else list(root.findall(".//testsuite"))
    counts = {name: 0 for name in ("tests", "failures", "errors", "skipped")}
    for suite in suites:
        for name in counts:
            try:
                counts[name] += int(suite.attrib.get(name, "0"))
            except ValueError as error:
                raise RuntimeError(
                    f"invalid JUnit {name} count in {junit_path}: {suite.attrib.get(name)!r}"
                ) from error
    return counts


def require_clean_tests(
    label: str, result: subprocess.CompletedProcess[str], counts: dict[str, int]
) -> None:
    if (
        result.returncode != 0
        or counts["tests"] == 0
        or counts["skipped"] > 0
        or counts["failures"] > 0
        or counts["errors"] > 0
    ):
        raise RuntimeError(f"{label} suite did not execute cleanly: {counts}")


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
            "Runs TypeScript and Python Qdrant vector adapter tests against "
            "a temporary native Qdrant 1.19.2 server. Env: QDRANT_BINARY, "
            "MIRK_QDRANT_PYTHON."
        )
        raise SystemExit(0)
    raise SystemExit(main())
