"""Human editable Markdown and YAML headmatter storage for Mirk.

The adapter is deliberately a synchronous ``SyncStore`` implementation. Files
are the source of truth: every read reparses the current directory, while
indexes and Git history remain derived conveniences.
"""

from __future__ import annotations

import base64
import os
import re
import subprocess
import tempfile
import unicodedata
from collections.abc import Callable, Mapping, MutableMapping
from pathlib import Path
from typing import Any, Protocol, Required, TypedDict, TypeGuard, cast

from mirk.store.types import StoreFilter, StoreMeta, SyncStore
from ruamel.yaml import YAML
from ruamel.yaml.comments import CommentedMap


class MarkdownSectionConfig(TypedDict, total=False):
    heading: Required[str]
    level: int
    parse: Callable[[str], Any]
    stringify: Callable[[Any], str]


class MarkdownBodyConfig(TypedDict, total=False):
    field: str
    preambleField: str
    sections: dict[str, MarkdownSectionConfig]


class MarkdownIndexConfig(TypedDict, total=False):
    fileName: str
    heading: str
    renderLine: Required[Callable[[Mapping[str, Any]], str]]


class MarkdownCollectionConfig(TypedDict, total=False):
    directory: str
    frontmatterFields: list[str] | str
    body: MarkdownBodyConfig
    fileName: Callable[[Mapping[str, Any]], str]
    index: MarkdownIndexConfig | bool


class MarkdownGitConfig(TypedDict, total=False):
    name: str
    email: str
    message: Callable[[Mapping[str, Any]], str]


class _YamlConstructor(Protocol):
    def add_constructor(self, tag: str, constructor: Callable[[Any, Any], Any]) -> None: ...


KV_COLLECTION = ".mirk-kv"
_SAFE_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
_HEADING = re.compile(r"^#{1,6}\s")


class MarkdownStoreError(ValueError):
    """A caller or filesystem operation violated the Markdown store contract."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


class MarkdownStoreCorruptionError(Exception):
    """One directory contained one or more malformed Markdown records."""

    def __init__(self, errors: list[Exception]) -> None:
        self.errors = errors
        super().__init__(
            f"Markdown store contains {len(errors)} corrupt record"
            f"{'' if len(errors) == 1 else 's'}: " + "; ".join(str(error) for error in errors)
        )


class _ParsedRecord:
    __slots__ = ("body", "document", "item", "path", "raw")

    def __init__(
        self, item: dict[str, Any], path: Path, raw: str, document: Any, body: str
    ) -> None:
        self.item = item
        self.path = path
        self.raw = raw
        self.document = document
        self.body = body


def _yaml() -> Any:
    parser = YAML(typ="rt")
    parser.preserve_quotes = True
    parser.width = 0
    parser.default_flow_style = False
    constructor = cast(_YamlConstructor, cast(Any, parser).constructor)
    constructor.add_constructor(
        "tag:yaml.org,2002:timestamp",
        _construct_timestamp,
    )
    constructor.add_constructor(
        "tag:yaml.org,2002:int",
        _construct_int,
    )
    return parser


def _construct_timestamp(loader: Any, node: Any) -> Any:
    return loader.construct_scalar(node)


def _construct_int(loader: Any, node: Any) -> Any:
    value = loader.construct_scalar(node)
    return value if "_" in value else loader.construct_yaml_int(node)


def _default_config() -> MarkdownCollectionConfig:
    return {"frontmatterFields": "all", "index": False}


def _body_config(config: Mapping[str, Any]) -> MarkdownBodyConfig:
    return cast(MarkdownBodyConfig, config.get("body") or {})


def _encode_name(value: str) -> str:
    if _SAFE_NAME.fullmatch(value) and value not in {".", ".."}:
        return value
    encoded = base64.urlsafe_b64encode(value.encode("utf-8")).decode("ascii").rstrip("=")
    return f"~{encoded}"


def _filename_alias(value: str) -> str:
    return unicodedata.normalize("NFC", value).casefold()


def _within(root: Path, candidate: Path) -> bool:
    try:
        candidate.relative_to(root)
        return True
    except ValueError:
        return False


def _join_within(root: Path, relative: str) -> Path:
    path = Path(os.path.abspath(os.path.join(root, relative)))
    if not _within(root, path):
        raise MarkdownStoreError(
            "path-escapes-root", f"Path escapes markdown store root: {relative}"
        )
    # Existing symlinks, and symlinked parents created by another process, may
    # not redirect a write outside the store root.
    real_parent = Path(os.path.realpath(path.parent))
    if path != root and not _within(root, real_parent):
        raise MarkdownStoreError(
            "path-escapes-root", f"Path escapes markdown store root: {relative}"
        )
    if path.exists() and not _within(root, Path(os.path.realpath(path))):
        raise MarkdownStoreError(
            "path-escapes-root", f"Path escapes markdown store root: {relative}"
        )
    return path


def _assert_record_id(record_id: Any) -> None:
    if not isinstance(record_id, str) or not record_id or "\0" in record_id:
        raise MarkdownStoreError(
            "invalid-record-id", "Markdown record id must be a non-empty string."
        )


def _is_plain_record(value: Any) -> TypeGuard[Mapping[str, Any]]:
    return isinstance(value, Mapping) and not isinstance(value, (list, tuple))


def _stringify_body(value: Any) -> str:
    if value is None:
        return ""
    if not isinstance(value, str):
        raise MarkdownStoreError(
            "non-string-body",
            "Markdown body fields must serialize to strings unless a section stringify "
            "function is configured.",
        )
    return value.strip()


def _heading_line(section: Mapping[str, Any]) -> str:
    return "#" * int(section.get("level", 2)) + " " + str(section["heading"])


def _read_preamble(body: str) -> str:
    lines = body.split("\n")
    first = next((index for index, line in enumerate(lines) if _HEADING.match(line)), -1)
    return "\n".join(lines if first == -1 else lines[:first]).strip()


def _write_preamble(body: str, value: str) -> str:
    lines = body.split("\n")
    first = next((index for index, line in enumerate(lines) if _HEADING.match(line)), -1)
    suffix = [] if first == -1 else lines[first:]
    return "\n\n".join(part for part in [value, "\n".join(suffix)] if part)


def _read_section(body: str, section: Mapping[str, Any]) -> str:
    lines = body.split("\n")
    marker = _heading_line(section)
    try:
        start = next(index for index, line in enumerate(lines) if line.rstrip() == marker)
    except StopIteration:
        return ""
    level = int(section.get("level", 2))
    end = len(lines)
    for index in range(start + 1, len(lines)):
        match = _HEADING.match(lines[index])
        if match is not None and len(match.group(0).split()[0]) <= level:
            end = index
            break
    return "\n".join(lines[start + 1 : end]).strip()


def _write_section(body: str, section: Mapping[str, Any], value: str) -> str:
    lines = [] if not body else body.split("\n")
    marker = _heading_line(section)
    try:
        start = next(index for index, line in enumerate(lines) if line.rstrip() == marker)
    except StopIteration:
        return "\n".join([*lines, *([""] if lines else []), marker, "", *value.split("\n")])
    level = int(section.get("level", 2))
    end = len(lines)
    for index in range(start + 1, len(lines)):
        match = _HEADING.match(lines[index])
        if match is not None and len(match.group(0).split()[0]) <= level:
            end = index
            break
    return "\n".join([*lines[:start], marker, "", *value.split("\n"), "", *lines[end:]])


def _strict_equal(left: Any, right: Any) -> bool:
    if isinstance(left, bool) or isinstance(right, bool):
        return type(left) is type(right) and left == right
    if isinstance(left, (int, float)) and isinstance(right, (int, float)):
        return left == right
    if isinstance(left, (str, int, float)) or left is None:
        return type(left) is type(right) and left == right
    return left is right


def _apply_filter(items: list[Any], filter_value: StoreFilter | None) -> list[Any]:
    result = list(items)
    if filter_value and filter_value.get("where") is not None:
        where = filter_value.get("where") or {}
        result = [
            item
            for item in result
            if _is_plain_record(item)
            and all(key in item and _strict_equal(item[key], value) for key, value in where.items())
        ]
    sort_by = filter_value.get("sortBy") if filter_value else None
    if isinstance(sort_by, str):
        field = sort_by
        direction = -1 if filter_value and filter_value.get("sortDir") == "desc" else 1
        present = [
            item for item in result if _is_plain_record(item) and item.get(field) is not None
        ]
        missing = [item for item in result if not _is_plain_record(item) or item.get(field) is None]
        present.sort(key=lambda item: item[field], reverse=direction < 0)
        result = [*present, *missing]
    offset = filter_value.get("offset", 0) if filter_value else 0
    if offset > 0:
        result = result[int(offset) :]
    limit = filter_value.get("limit") if filter_value else None
    if limit is not None and limit >= 0:
        result = result[: int(limit)]
    return result


class MarkdownStore(SyncStore):
    """A human-editable, synchronous Mirk store backed by Markdown files."""

    @property
    def meta(self) -> StoreMeta:
        return StoreMeta(backend="markdown")

    def __init__(
        self,
        root_dir: str | os.PathLike[str],
        *,
        collections: Mapping[str, MarkdownCollectionConfig] | None = None,
        git: bool | MarkdownGitConfig = False,
    ) -> None:
        self.root_dir = Path(root_dir).expanduser().resolve()
        self.root_dir.mkdir(parents=True, exist_ok=True)
        self.collections = cast(
            dict[str, MarkdownCollectionConfig],
            {str(key): dict(value) for key, value in (collections or {}).items()},
        )
        if git is False:
            self._git_config: MarkdownGitConfig | None = None
        elif git is True:
            self._git_config = {}
        else:
            self._git_config = cast(MarkdownGitConfig, dict(git))
        self._git_available = False
        self._temp_counter = 0
        self._initialize_git()

    def get(self, key: str) -> Any:
        record = self._read_kv_record(key)
        return None if record is None else record.item.get("value")

    def set(self, key: str, value: Any) -> None:
        _assert_record_id(key)
        directory = self.root_dir / KV_COLLECTION
        directory.mkdir(parents=True, exist_ok=True)
        path = _join_within(self.root_dir, f"{KV_COLLECTION}/{_encode_name(key)}.md")
        existing_records = self._read_directory(directory, _default_config())
        alias = next(
            (
                record
                for record in existing_records
                if _filename_alias(record.path.name) == _filename_alias(path.name)
                and record.item.get("id") != key
            ),
            None,
        )
        if alias is not None:
            raise MarkdownStoreError(
                "filename-collision",
                "Markdown filename collision: "
                f"{path} already belongs to record {alias.item.get('id')}.",
            )
        existing = self._parse_record(path, _default_config()) if path.exists() else None
        self._write_record(
            path, {"id": key, "value": value}, _default_config(), existing.raw if existing else None
        )
        self._commit({"operation": "set", "key": key}, [path])

    def has(self, key: str) -> bool:
        return self._read_kv_record(key) is not None

    def delete(self, key: str) -> bool:
        record = self._read_kv_record(key)
        if record is None:
            return False
        path = record.path
        path.unlink()
        self._commit({"operation": "delete", "key": key}, [path])
        return True

    def keys(self, prefix: str | None = None) -> list[str]:
        directory = self.root_dir / KV_COLLECTION
        if not directory.exists():
            return []
        keys = [
            str(record.item["id"]) for record in self._read_directory(directory, _default_config())
        ]
        return sorted(key for key in keys if prefix is None or key.startswith(prefix))

    def list(self, collection: str, filter: StoreFilter | None = None) -> list[Any]:
        return _apply_filter([record.item for record in self._read_collection(collection)], filter)

    def getById(self, collection: str, id: str) -> Any:
        config = self._config_for(collection)
        directory = self._directory_for(collection, config)
        if not directory.exists():
            return None
        filename = config.get("fileName")
        if filename is None:
            path = _join_within(
                self.root_dir,
                f"{config.get('directory', _encode_name(collection))}/{_encode_name(id)}.md",
            )
            if not path.exists():
                return None
            record = self._parse_record(path, config)
            return record.item if record.item.get("id") == id else None
        return next(
            (
                record.item
                for record in self._read_directory(directory, config)
                if record.item.get("id") == id
            ),
            None,
        )

    def put(self, collection: str, item: Mapping[str, Any]) -> dict[str, Any]:
        record = dict(item)
        _assert_record_id(record.get("id"))
        config = self._config_for(collection)
        index_name = self._index_file_name(config)
        directory = self._directory_for(collection, config)
        self._validate_index_destination(directory, index_name)
        directory.mkdir(parents=True, exist_ok=True)
        records = self._read_directory(directory, config)
        existing = next(
            (candidate for candidate in records if candidate.item.get("id") == record["id"]), None
        )
        path = (
            existing.path
            if existing
            else _join_within(
                self.root_dir,
                f"{config.get('directory', _encode_name(collection))}/"
                f"{self._new_file_name(record, config)}",
            )
        )
        if existing is None:
            alias = next(
                (
                    candidate
                    for candidate in records
                    if _filename_alias(candidate.path.name) == _filename_alias(path.name)
                ),
                None,
            )
            if alias is not None:
                raise MarkdownStoreError(
                    "filename-collision",
                    "Markdown filename collision: "
                    f"{path} already belongs to record {alias.item.get('id')}.",
                )
        if existing is None and path.exists():
            occupant = self._parse_record(path, config)
            raise MarkdownStoreError(
                "filename-collision",
                "Markdown filename collision: "
                f"{path} already belongs to record {occupant.item.get('id')}.",
            )
        self._write_record(path, record, config, existing.raw if existing else None)
        index_path = self._regenerate_index(collection, config, index_name)
        self._commit(
            {"operation": "put", "collection": collection, "id": record["id"]},
            [path, *([index_path] if index_path is not None else [])],
        )
        return record

    def remove(self, collection: str, id: str) -> bool:
        config = self._config_for(collection)
        index_name = self._index_file_name(config)
        self._validate_index_destination(self._directory_for(collection, config), index_name)
        existing = next(
            (record for record in self._read_collection(collection) if record.item.get("id") == id),
            None,
        )
        if existing is None:
            return False
        existing.path.unlink()
        index_path = self._regenerate_index(collection, config, index_name)
        self._commit(
            {"operation": "remove", "collection": collection, "id": id},
            [existing.path, *([index_path] if index_path is not None else [])],
        )
        return True

    def count(self, collection: str, filter: StoreFilter | None = None) -> int:
        return len(self.list(collection, filter))

    def _read_kv_record(self, key: str) -> _ParsedRecord | None:
        path = _join_within(self.root_dir, f"{KV_COLLECTION}/{_encode_name(key)}.md")
        if not path.exists():
            return None
        record = self._parse_record(path, _default_config())
        return record if record.item.get("id") == key else None

    def _config_for(self, collection: str) -> dict[str, Any]:
        return dict(self.collections.get(collection, _default_config()))

    def _directory_for(self, collection: str, config: Mapping[str, Any]) -> Path:
        return _join_within(self.root_dir, str(config.get("directory", _encode_name(collection))))

    def _read_collection(self, collection: str) -> list[_ParsedRecord]:
        config = self._config_for(collection)
        directory = self._directory_for(collection, config)
        return self._read_directory(directory, config) if directory.exists() else []

    def _read_directory(self, directory: Path, config: Mapping[str, Any]) -> list[_ParsedRecord]:
        index_name = self._index_file_name(config)
        records: list[_ParsedRecord] = []
        errors: list[Exception] = []
        for entry in sorted(directory.iterdir(), key=lambda path: path.name):
            if (
                entry.is_symlink()
                or not entry.is_file()
                or not entry.name.endswith(".md")
                or (
                    index_name is not None
                    and _filename_alias(entry.name) == _filename_alias(index_name)
                )
            ):
                continue
            try:
                records.append(self._parse_record(entry, config))
            except Exception as error:
                errors.append(error)
        if errors:
            raise MarkdownStoreCorruptionError(errors)
        return sorted(records, key=lambda record: str(record.item.get("id", "")))

    def _parse_record(self, path: Path, config: Mapping[str, Any]) -> _ParsedRecord:
        with path.open("r", encoding="utf-8", newline="") as handle:
            raw = handle.read().lstrip("\ufeff")
        document, body = _parse_frontmatter(raw, path)
        data: Mapping[str, Any] = (
            cast(Mapping[str, Any], document) if isinstance(document, Mapping) else {}
        )
        if not _is_plain_record(data) or not isinstance(data.get("id"), str) or not data.get("id"):
            raise MarkdownStoreError(
                "missing-record-id", f"{path}: frontmatter must contain a non-empty string id"
            )
        item = dict(data)
        body_config = _body_config(config)
        body_field = body_config.get("field")
        if isinstance(body_field, str):
            item[body_field] = body[:-1] if body.endswith("\n") else body
        preamble_field = body_config.get("preambleField")
        if isinstance(preamble_field, str):
            item[preamble_field] = _read_preamble(body)
        sections = body_config.get("sections") or {}
        for field, section in sections.items():
            markdown = _read_section(body, section)
            parser = section.get("parse")
            item[field] = parser(markdown) if callable(parser) else markdown
        return _ParsedRecord(item, path, raw, document, body)

    def _write_record(
        self, path: Path, item: dict[str, Any], config: Mapping[str, Any], existing_raw: str | None
    ) -> None:
        document: Any
        if existing_raw is None:
            document = CommentedMap()
            body = ""
        else:
            document, body = _parse_frontmatter(existing_raw, path)
            if not isinstance(document, CommentedMap):
                document = CommentedMap(document or {})
        fields_config = config.get("frontmatterFields", "all")
        fields: list[str] = (
            list(item.keys())
            if fields_config == "all"
            else ["id", *cast(list[str], fields_config or [])]
        )
        body_config = _body_config(config)
        body_field = body_config.get("field")
        preamble_field = body_config.get("preambleField")
        body_fields: set[str] = set()
        for candidate in (body_config.get("field"), body_config.get("preambleField")):
            if isinstance(candidate, str):
                body_fields.add(candidate)
        body_fields.update((body_config.get("sections") or {}).keys())
        for field in dict.fromkeys(fields):
            if field in body_fields:
                continue
            if field in item:
                document[field] = item[field]
            else:
                cast(MutableMapping[str, Any], document).pop(field, None)
        if isinstance(body_field, str):
            body = _stringify_body(item.get(body_field))
        if isinstance(preamble_field, str):
            body = _write_preamble(body, _stringify_body(item.get(preamble_field)))
        for field, section in (body_config.get("sections") or {}).items():
            stringify = section.get("stringify")
            value = (
                stringify(item.get(field))
                if callable(stringify)
                else _stringify_body(item.get(field))
            )
            body = _write_section(body, cast(Mapping[str, Any], section), value)
        with tempfile.SpooledTemporaryFile(mode="w+", encoding="utf-8") as stream:
            _yaml().dump(document, stream)
            stream.seek(0)
            yaml_text = stream.read().rstrip()
        rendered_body = body.lstrip("\n")
        output = f"---\n{yaml_text}\n---\n"
        if rendered_body:
            output += f"\n{rendered_body}{'' if rendered_body.endswith(chr(10)) else chr(10)}"
        self._atomic_write(path, output)

    def _new_file_name(self, item: Mapping[str, Any], config: Mapping[str, Any]) -> str:
        callback = config.get("fileName")
        candidate = (
            str(callback(item)) if callable(callback) else f"{_encode_name(str(item['id']))}.md"
        )
        index_name = self._index_file_name(config)
        if (
            Path(candidate).name != candidate
            or not candidate.endswith(".md")
            or (
                index_name is not None and _filename_alias(candidate) == _filename_alias(index_name)
            )
        ):
            raise MarkdownStoreError(
                "unsafe-filename", f"Unsafe markdown record filename: {candidate!r}"
            )
        return candidate

    def _regenerate_index(
        self, collection: str, config: Mapping[str, Any], index_name: str | None = None
    ) -> Path | None:
        index = config.get("index")
        if index is False or not isinstance(index, Mapping):
            return None
        index_name = index_name or self._index_file_name(config)
        index_config = cast(MarkdownIndexConfig, index)
        directory = self._directory_for(collection, config)
        items = [record.item for record in self._read_directory(directory, config)]
        render = index_config.get("renderLine")
        if not callable(render):
            raise TypeError("Markdown index config requires renderLine")
        heading = str(index_config.get("heading", collection))
        lines = [str(render(item)) for item in items]
        rendered_lines = "\n".join(lines)
        output = f"# {heading}\n" + (f"\n{rendered_lines}\n" if lines else "")
        path = directory / str(index_name)
        self._atomic_write(path, output)
        return path

    def _index_file_name(self, config: Mapping[str, Any]) -> str | None:
        index = config.get("index")
        if index is False or index is None:
            return None
        candidate = str(cast(Mapping[str, Any], index).get("fileName", "INDEX.md"))
        if Path(candidate).name != candidate or not candidate.endswith(".md"):
            raise MarkdownStoreError(
                "unsafe-filename", f"Unsafe markdown index filename: {candidate!r}"
            )
        return candidate

    def _validate_index_destination(self, directory: Path, index_name: str | None) -> None:
        if index_name is None:
            return
        if not directory.exists():
            return
        alias = next(
            (
                entry
                for entry in directory.iterdir()
                if entry.is_file() and _filename_alias(entry.name) == _filename_alias(index_name)
            ),
            None,
        )
        path = _join_within(
            self.root_dir,
            os.path.relpath(alias or directory / index_name, self.root_dir),
        )
        if not path.exists():
            return
        with path.open("r", encoding="utf-8", newline="") as handle:
            raw = handle.read().lstrip("\ufeff")
        if not raw.startswith("---\n"):
            return
        document, _ = _parse_frontmatter(raw, path)
        data: Mapping[str, Any] = (
            cast(Mapping[str, Any], document) if isinstance(document, Mapping) else {}
        )
        if isinstance(data.get("id"), str) and data.get("id"):
            raise MarkdownStoreError(
                "filename-collision",
                f"Markdown index filename {path} already belongs to record {data['id']}.",
            )
        raise MarkdownStoreCorruptionError(
            [
                MarkdownStoreError(
                    "missing-record-id", f"{path}: frontmatter must contain a non-empty string id"
                )
            ]
        )

    def _atomic_write(self, path: Path, contents: str) -> None:
        path = _join_within(self.root_dir, os.path.relpath(path, self.root_dir))
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.parent / f".{path.name}.{os.getpid()}.{self._temp_counter}.tmp"
        self._temp_counter += 1
        try:
            with temporary.open("x", encoding="utf-8", newline="\n") as handle:
                handle.write(contents)
            os.replace(temporary, path)
        finally:
            if temporary.exists():
                temporary.unlink()

    def _initialize_git(self) -> None:
        if self._git_config is None:
            return
        try:
            if not (self.root_dir / ".git").exists():
                subprocess.run(
                    ["git", "-C", str(self.root_dir), "init"],
                    check=True,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                )
            subprocess.run(
                ["git", "-C", str(self.root_dir), "rev-parse", "--git-dir"],
                check=True,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            self._git_available = True
        except Exception:
            self._git_available = False

    def _commit(self, mutation: Mapping[str, Any], paths: list[Path]) -> None:
        if not self._git_available or self._git_config is None:
            return
        message_factory = self._git_config.get("message")
        message = (
            message_factory(mutation)
            if callable(message_factory)
            else _default_commit_message(mutation)
        )
        name = str(self._git_config.get("name", "Mirk Markdown Store"))
        email = str(self._git_config.get("email", "store-markdown@mirk.local"))
        try:
            relative_paths = [os.path.relpath(path, self.root_dir) for path in paths]
            subprocess.run(
                [
                    "git",
                    "--literal-pathspecs",
                    "-C",
                    str(self.root_dir),
                    "add",
                    "--",
                    *relative_paths,
                ],
                check=True,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            subprocess.run(
                [
                    "git",
                    "--literal-pathspecs",
                    "-C",
                    str(self.root_dir),
                    "-c",
                    f"user.name={name}",
                    "-c",
                    f"user.email={email}",
                    "commit",
                    "--quiet",
                    "--only",
                    "-m",
                    str(message),
                    "--",
                    *relative_paths,
                ],
                check=True,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
        except Exception:
            pass


def _parse_frontmatter(raw: str, path: Path) -> tuple[Any, str]:
    if not raw.startswith("---\n"):
        raise MarkdownStoreError(
            "missing-frontmatter-open", f"{path}: missing YAML frontmatter opening delimiter"
        )
    end = raw.find("\n---", 4)
    if end == -1:
        raise MarkdownStoreError(
            "missing-frontmatter-close", f"{path}: missing YAML frontmatter closing delimiter"
        )
    try:
        document = _yaml().load(raw[4:end])
    except Exception as error:
        raise MarkdownStoreError("invalid-frontmatter", f"{path}: {error}") from error
    body = raw[end + 4 :]
    if body.startswith("\n"):
        body = body[1:]
    return document if document is not None else CommentedMap(), body


def _default_commit_message(mutation: Mapping[str, Any]) -> str:
    operation = str(mutation.get("operation"))
    if operation in {"set", "delete"}:
        return f"kv {mutation.get('key')}: {operation}"
    return f"{mutation.get('collection')} {mutation.get('id')}: {operation}"


__all__ = ["MarkdownStore", "MarkdownStoreCorruptionError", "MarkdownStoreError"]
