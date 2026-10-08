# mirk-store-markdown

Human-editable Markdown and YAML headmatter storage behind Mirk's synchronous
store contract. Records remain ordinary files, unknown frontmatter and body
sections survive updates, and collection indexes are derived projections.

KV keys and collection record IDs must be non-empty strings. YAML uses the
same scalar policy as the TypeScript adapter: dates and underscore-formatted
numbers remain strings, while YAML booleans such as `true` remain booleans.

```python
from mirk.store_markdown import MarkdownStore

store = MarkdownStore(
    "/data/records",
    collections={
        "stories": {
            "directory": "stories",
            "frontmatterFields": ["title", "status"],
            "body": {"preambleField": "intent"},
        }
    },
)
store.put("stories", {"id": "DOC-101", "title": "Example", "status": "todo", "intent": "Text."})
```

The parser uses YAML 1.2 round-trip mode. Writes use a temporary sibling and
atomic replacement. Optional Git history commits the mutated record and its derived index.
It preserves unrelated staged changes and never pushes. A Git failure does not undo a file mutation.
Index filenames are reserved with Unicode normalization and case folding, so case variants cannot overwrite records on common filesystems.
Ambiguous record filenames are rejected. Reads and deletes check the stored ID before acting on a filename alias.

Markdown collections sort records by Unicode code point ID before applying the
filter. `count` includes pagination, and `limit < 0` means no limit.
These are Markdown-specific behaviors, shared with the TypeScript adapter.
`where` uses strict scalar equality. The adapter does not provide atomic mutations, leases, search,
or vector capabilities.
Use one scalar type within a sorted field. Ordering across mixed types is not a portable contract.

The shared Markdown corpus compares parsed values and stable error codes.
It does not require identical YAML formatting from the two serializers.
Native tests also exchange the same files across Python and TypeScript.
