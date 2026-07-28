# `@mirk/store-markdown`

Human-editable Markdown and YAML-headmatter persistence behind Mirk's synchronous store contract.
Use it when records should remain ordinary files that people and tools can edit directly while
applications continue to use `@mirk/store` rather than a bespoke filesystem store.

```bash
npm install @mirk/store-markdown
```

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
```

Unknown frontmatter keys and unconfigured Markdown sections survive updates. Reads always return
current disk contents; writes use a temporary sibling followed by atomic rename. A custom filename
is chosen only when a record is created, so title changes do not rename files. An index is a derived
projection and is regenerated after collection mutations.

Git is optional durability history. When enabled, the adapter initializes a fresh repository and
creates one commit per successful store mutation. Git failure never invalidates the filesystem
mutation, and the adapter never pushes or manages branches.

V1 assumes one writing process. Atomic replacement prevents torn individual files, but two writers
can still overwrite one another and index generation is last-writer-wins.

Malformed files are never skipped. `list()` scans the collection and throws
`MarkdownStoreCorruptionError` containing every failing path. The base `SyncStore` contract cannot
currently return valid items together with per-record diagnostics; a future minimal port extension
could add a diagnostic collection-read result without changing normal `list()` semantics.
