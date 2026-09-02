"""Fixture sources: memory, store, filesystem.

Each is imported from its own module rather than re-exported here, mirroring
the subpath entry points `@mirk/fixtures/memory`, `/store` and `/filesystem`.
The filesystem source touches the disk; the other two do not.
"""
