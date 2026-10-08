"""Filesystem-backed object store with portable sidecar metadata."""

from __future__ import annotations

import json
import os
import stat
import uuid
from collections.abc import Iterator
from pathlib import Path
from typing import cast

from .errors import ArtifactValidationError
from .memory import ObjectAlreadyExistsError
from .types import ByteSource, ObjectInfo, ObjectPutOptions
from .util import assertObjectKey, chunks

__all__ = ["FileObjectStore"]

_BYTES_SUFFIX = ".bin"
_SIDECAR_SUFFIX = ".sidecar.json"


class FileObjectStore:
    """Durable local bytes at ``<root>/<key>.bin`` plus a JSON sidecar."""

    def __init__(self, root: str | os.PathLike[str]) -> None:
        self._root = Path(root).expanduser().resolve()

    def put(
        self, key: str, source: ByteSource, options: ObjectPutOptions | None = None
    ) -> ObjectInfo:
        assertObjectKey(key)
        options = options or {}
        bytes_path = self._path(key, _BYTES_SUFFIX)
        bytes_path.parent.mkdir(parents=True, exist_ok=True)
        self._assert_safe_path(bytes_path)
        flags = os.O_WRONLY | os.O_CREAT
        if options.get("ifAbsent"):
            flags |= os.O_EXCL
        else:
            flags |= os.O_TRUNC
        if hasattr(os, "O_NOFOLLOW"):
            flags |= os.O_NOFOLLOW
        try:
            fd = os.open(bytes_path, flags, 0o644)
        except FileExistsError as exc:
            if options.get("ifAbsent"):
                raise ObjectAlreadyExistsError(key) from exc
            raise

        size = 0
        try:
            with os.fdopen(fd, "wb") as handle:
                for chunk in chunks(source):
                    handle.write(chunk)
                    size += len(chunk)
        except BaseException as cause:
            # If this operation created the object, remove its partial bytes.
            # For overwrite failures the previous bytes were already replaced;
            # deleting them would make retry and recovery less safe.
            if options.get("ifAbsent"):
                self._cleanup_if_absent(key, cause)
            raise

        info: ObjectInfo = {"key": key, "sizeBytes": size}
        media_type = options.get("mediaType")
        metadata = options.get("metadata")
        if media_type:
            info["mediaType"] = media_type
        if metadata is not None:
            info["metadata"] = dict(metadata)
        try:
            self._write_sidecar(key, info)
        except BaseException as cause:
            if options.get("ifAbsent"):
                self._cleanup_if_absent(key, cause)
            raise
        return info

    def get(self, key: str) -> Iterator[bytes] | None:
        assertObjectKey(key)
        path = self._path(key, _BYTES_SUFFIX)
        self._assert_safe_path(path)
        if not path.is_file():
            return None

        def stream() -> Iterator[bytes]:
            flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
            fd = os.open(path, flags)
            with os.fdopen(fd, "rb") as handle:
                while chunk := handle.read(1024 * 1024):
                    yield chunk

        return stream()

    def head(self, key: str) -> ObjectInfo | None:
        assertObjectKey(key)
        sidecar = self._read_sidecar(key)
        if sidecar is not None:
            return sidecar
        bytes_path = self._path(key, _BYTES_SUFFIX)
        self._assert_safe_path(bytes_path)
        try:
            stats = bytes_path.lstat()
            if stat.S_ISREG(stats.st_mode):
                return {"key": key, "sizeBytes": stats.st_size}
        except OSError:
            pass
        return None

    def delete(self, key: str) -> bool:
        assertObjectKey(key)
        bytes_path = self._path(key, _BYTES_SUFFIX)
        sidecar_path = self._path(key, _SIDECAR_SUFFIX)
        self._assert_safe_path(bytes_path)
        self._assert_safe_path(sidecar_path)
        try:
            existed = stat.S_ISREG(bytes_path.lstat().st_mode)
        except OSError:
            existed = False
        bytes_path.unlink(missing_ok=True)
        sidecar_path.unlink(missing_ok=True)
        return existed

    def list(self, prefix: str = "") -> list[ObjectInfo]:
        if prefix:
            assertObjectKey(prefix)
        if not self._root.is_dir():
            return []
        keys: list[str] = []
        for directory, dirnames, filenames in os.walk(self._root, followlinks=False):
            # A symlinked directory is an escape route and is not an object.
            dirnames[:] = [name for name in dirnames if not (Path(directory) / name).is_symlink()]
            for filename in filenames:
                if filename.endswith(_BYTES_SUFFIX):
                    path = Path(directory) / filename
                    if path.is_symlink():
                        continue
                    key = path.relative_to(self._root).as_posix()[: -len(_BYTES_SUFFIX)]
                    if key.startswith(prefix):
                        keys.append(key)
        keys.sort()
        return [info for key in keys if (info := self.head(key)) is not None]

    def _path(self, key: str, suffix: str) -> Path:
        full = (self._root / f"{key}{suffix}").resolve(strict=False)
        root = self._root
        if full != root and root not in full.parents:
            raise ArtifactValidationError(
                "object-key-escapes-root", f"object key escapes store root: {key!r}"
            )
        return full

    def _assert_safe_path(self, path: Path) -> None:
        # ``resolve`` follows existing symlinks, so a key through a symlinked
        # directory or final object is rejected before any read/write.
        root = self._root
        resolved = path.resolve(strict=False)
        if resolved != root and root not in resolved.parents:
            raise ArtifactValidationError(
                "object-key-escapes-root", f"object key escapes store root: {path!s}"
            )

    def _write_sidecar(self, key: str, info: ObjectInfo) -> None:
        path = self._path(key, _SIDECAR_SUFFIX)
        path.parent.mkdir(parents=True, exist_ok=True)
        self._assert_safe_path(path)
        temporary = path.with_name(f"{path.name}.tmp-{uuid.uuid4()}")
        try:
            with temporary.open("x", encoding="utf-8") as handle:
                json.dump(info, handle, ensure_ascii=False, separators=(",", ":"))
            os.replace(temporary, path)
        except BaseException as cause:
            try:
                temporary.unlink(missing_ok=True)
            except BaseException:
                if not isinstance(cause, Exception):
                    raise cause from None
                raise
            raise

    def _cleanup_if_absent(self, key: str, cause: BaseException) -> None:
        cleanup_error: BaseException | None = None
        for suffix in (_BYTES_SUFFIX, _SIDECAR_SUFFIX):
            try:
                path = self._path(key, suffix)
                self._assert_safe_path(path)
                path.unlink(missing_ok=True)
            except BaseException as error:
                cleanup_error = cleanup_error or error
        if cleanup_error is not None:
            if not isinstance(cause, Exception):
                raise cause from None
            raise cleanup_error

    def _read_sidecar(self, key: str) -> ObjectInfo | None:
        path = self._path(key, _SIDECAR_SUFFIX)
        self._assert_safe_path(path)
        flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
        try:
            fd = os.open(path, flags)
            with os.fdopen(fd, "r", encoding="utf-8") as handle:
                value = json.load(handle)
            return cast(ObjectInfo, value) if isinstance(value, dict) else None
        except (OSError, ValueError, UnicodeError):
            return None
