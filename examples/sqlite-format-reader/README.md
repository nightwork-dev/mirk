# A reader pinned to core format 2

This independent Rust probe links system SQLite and has no Mirk or JSON dependency. It opens
read-only, checks the core marker first, reads one legacy vector using explicit little-endian
float32 conversion, and returns one KV JSON value as raw UTF-8 hex. It refuses newer formats.

```sh
rustc --edition=2021 examples/sqlite-format-reader/reader.rs -o /tmp/mirk-format-reader
/tmp/mirk-format-reader testdata/sqlite-format/v2.sqlite assets a unicode
/tmp/mirk-format-reader testdata/sqlite-format/v3.sqlite assets a unicode
```

The second command exits with status 2 before querying vector tables. The reader does not migrate,
create tables, or claim to implement the full port. JSON is deliberately returned as bytes with
`json_decoded:false`. Escaped lone UTF-16 surrogates cannot be decoded losslessly into an ordinary
Rust `String`. Decimal float32 components are strings so non-finite components do not produce
invalid JSON output. CLI text arguments cannot carry embedded NUL bytes.

The [format contract](../../docs/format.md) describes all facets and historical variants. Run
`python3 scripts/test-sqlite-format-goldens.py` for Python/Node agreement, source-file hash checks,
explicit regeneration checks, and compilation/execution of this reader when Rust is installed.
