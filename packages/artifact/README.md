# @mirk/artifact

Portable artifact identity, SHA-256 integrity, metadata, lineage, and coordination over a small object-store port.

The root package is runtime-neutral. Use `@mirk/artifact/store` to persist records through `@mirk/store/kv`; use a separate adapter such as `@mirk/artifact-opendal` for production object-storage backends.
