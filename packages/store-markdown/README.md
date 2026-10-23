# @mirk/store-markdown

> **Records that stay ordinary Markdown files.** Your app reads and writes them through Mirk, and
> people (and tools like editors and git) can edit them directly.

## Why

Some data is better as files a person can open. A roadmap of stories, a folder of notes, a set of
characters: you want to fix a typo in a text editor, review a change in git, and still have your
app list, filter, and update the same records. Writing a one-off filesystem store for each of
these means redoing the same care about renames, half-written files, and unknown fields.

This adapter does that once. Each record is a Markdown file with a block of YAML at the top (the
headmatter). Your app uses the same synchronous store interface as the rest of `@mirk/store`.

What you give up compared with the SQLite file in `@mirk/store`:

- **One writer.** Two processes writing at once can overwrite each other.
- **Only key-values and collections.** No vectors, no full-text search, no links.
- **No atomic batches and no transactions.** Each mutation stands alone.
- **Reads hit the disk each time.** You get the current files, which is the point, but it is not
  a fast database.

## A first look

```ts
import { MarkdownStore } from "@mirk/store-markdown";

const store = new MarkdownStore({
  rootDir: "/data/roadmap",
  git: true,
  collections: {
    stories: {
      directory: "stories",
      frontmatterFields: ["title", "status", "assignee"],
      body: {
        preambleField: "intent",
        sections: {
          acceptanceCriteria: { heading: "Acceptance criteria" },
        },
      },
      index: {
        heading: "Roadmap",
        renderLine: (story) => `- ${story.id} · ${story.title} · ${story.status}`,
      },
    },
  },
});

store.put("stories", {
  id: "DOC-101",
  title: "Adopt Mirk markdown storage",
  status: "todo",
  intent: "Retire the app-local repository.",
  acceptanceCriteria: "- [ ] Board and text edits agree",
});

store.list("stories", { where: { status: "todo" } });
```

That `put` writes `stories/DOC-101.md` and regenerates `stories/INDEX.md`:

```markdown
---
id: DOC-101
title: Adopt Mirk markdown storage
status: todo
---

Retire the app-local repository.

## Acceptance criteria

- [ ] Board and text edits agree
```

## Install

```bash
npm install @mirk/store-markdown
```

ESM-only. The store implements `SyncStore`, so calls are synchronous; wrap it with `toAsync` from
`@mirk/store/kv` where code needs the async interface.

## What it covers

| Capability | Covered | Notes |
| --- | --- | --- |
| Key-values | yes | `SyncStore` |
| Collections | yes | one directory per collection, one file per record |
| Vectors | no | |
| Full-text search | no | |
| Atomic writes | no | no multi-record batches; each single write replaces its file in one step |

### Where it differs from the reference

The in-memory and SQLite stores are the reference. This adapter differs in these ways:

- Reads always return current disk contents, so edits made outside the app show up immediately.
- Malformed files are never skipped: `list()` throws (see [Errors](#errors)). The reference stores
  have no such failure.
- Only one writing process is supported.
- Unknown frontmatter keys and unconfigured Markdown sections survive updates, because the file is
  the source of truth.

## How records map to files

- Writes use a temporary sibling file followed by an atomic rename, so a reader never sees a torn
  file.
- A custom filename (`fileName` in the collection config) is chosen only when a record is created,
  so changing a title does not rename the file.
- An index is a derived projection and is regenerated after collection mutations.
- Keys and record IDs must be non-empty strings. Index filenames are safe basenames, reserved
  with Unicode normalization and case folding. Filename collisions cannot overwrite records, and
  reads and deletes verify the stored identity.

## Git history

Git is optional durability history. With `git: true` (or a `MarkdownGitConfig` with `name`,
`email`, and a `message` function), the adapter initializes a fresh repository and creates one
commit per successful store mutation, limited to the record and derived index. Unrelated staged
changes remain staged. A git failure never invalidates the filesystem mutation, and the adapter
never pushes or manages branches.

## Reference

### Concurrency

V1 assumes one writing process. Atomic replacement prevents torn individual files, but two writers
can still overwrite one another, and index generation is last-writer-wins.

### Errors

Malformed files are never skipped. `list()` scans the collection and throws
`MarkdownStoreCorruptionError` containing every failing path; there is no partial read that returns
the valid records alongside diagnostics.

Other failures throw `MarkdownStoreError` with a `code`: `filename-collision`, `unsafe-filename`,
`path-escapes-root`, `invalid-record-id`, `non-string-body`, `missing-record-id`,
`missing-frontmatter-open`, `missing-frontmatter-close`, or `invalid-frontmatter`.

## License

Apache-2.0
