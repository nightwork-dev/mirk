import {
  defineScenario,
  type AuthoredStep,
} from "../../src/conformance/define.js";

const check = (op: string, ...args: unknown[]): AuthoredStep => ({
  op,
  args,
  expect: { value: true },
});
const setup = (op: string, ...args: unknown[]): AuthoredStep => ({ op, args });
const failure = (op: string, ...args: unknown[]) => check("failure", op, args);
const scenario = (
  id: string,
  steps: AuthoredStep[],
  config: Record<string, unknown> = {}
) =>
  defineScenario({
    id: `markdown/${id}`,
    title: id.replaceAll("-", " "),
    ports: ["store_markdown"],
    steps: [setup("configure", config), ...steps],
  });
const note = (extra: Record<string, unknown> = {}) => ({
  id: "note-1",
  title: "First Note",
  status: "draft",
  summary: "Opening paragraph.",
  details: "Details here.",
  ...extra,
});

export const scenarios = [
  scenario("kv-roundtrip", [
    setup("set", "settings/theme", { mode: "dark", nullable: null }),
    check("get", "settings/theme"),
    check("has", "settings/theme"),
    check("keys", "settings/"),
    check("delete", "settings/theme"),
    check("get", "settings/theme"),
    check("has", "settings/theme"),
    check("delete", "settings/theme"),
  ]),
  scenario("kv-null-is-present", [
    setup("set", "nil", null),
    check("get", "nil"),
    check("has", "nil"),
    check("has", "absent"),
  ]),
  scenario("kv-alias-cannot-read-or-delete-another-key", [
    setup("set", "Catalog", "preserved"),
    check("get", "catalog"),
    check("has", "catalog"),
    check("delete", "catalog"),
    check("get", "Catalog"),
  ]),
  scenario("record-id-lookup-does-not-return-an-alias", [
    setup("put", "things", { id: "Catalog" }),
    check("getById", "things", "catalog"),
    check("remove", "things", "catalog"),
    check("getById", "things", "Catalog"),
  ]),
  scenario("kv-scalar-and-array-values", [
    setup("set", "text", "yes"),
    setup("set", "items", [true, 1, "1", { nested: false }]),
    check("get", "text"),
    check("get", "items"),
  ]),
  scenario("kv-empty-key-is-rejected", [failure("set", "", 1), check("files")]),
  scenario("kv-encoded-names", [
    setup("set", "../x", 1),
    setup("set", "é/🌱", 2),
    check("keys"),
    check("get", "../x"),
    check("get", "é/🌱"),
    check("files"),
  ]),
  scenario("kv-code-point-order", [
    setup("set", "🌱", 1),
    setup("set", "�", 2),
    setup("set", "a", 3),
    setup("set", "B", 4),
    check("keys"),
  ]),
  scenario("record-order-is-id-order", [
    setup("put", "things", { id: "z", rank: 1 }),
    setup("put", "things", { id: "a", rank: 2 }),
    check("list", "things"),
    check("getById", "things", "a"),
    check("count", "things"),
  ]),
  scenario("record-encoded-id", [
    setup("put", "things", { id: "x/y", value: "saved" }),
    check("getById", "things", "x/y"),
    check("files"),
  ]),
  scenario("record-invalid-id", [
    failure("put", "things", { id: "", text: "bad" }),
    failure("put", "things", { id: "nul\0id" }),
    check("files"),
  ]),
  scenario("record-remove", [
    setup("put", "things", { id: "a" }),
    check("remove", "things", "a"),
    check("remove", "things", "a"),
    check("list", "things"),
  ]),
  scenario("strict-scalar-filtering", [
    setup("put", "things", { id: "a", value: true }),
    setup("put", "things", { id: "b", value: 1 }),
    setup("put", "things", { id: "c", value: "1" }),
    check("list", "things", { where: { value: true } }),
    check("list", "things", { where: { value: 1 } }),
  ]),
  scenario("non-scalar-filters-do-not-match-copied-records", [
    setup("put", "things", { id: "a", values: [1], nested: { a: 1 } }),
    check("list", "things", { where: { values: [1] } }),
    check("list", "things", { where: { nested: { a: 1 } } }),
  ]),
  scenario("string-fields-sort-by-code-point", [
    setup("put", "things", { id: "a", label: "🌱" }),
    setup("put", "things", { id: "b", label: "�" }),
    check("list", "things", { sortBy: "label" }),
    check("list", "things", { sortBy: "label", sortDir: "desc" }),
  ]),
  scenario("null-and-missing-filtering", [
    setup("put", "things", { id: "a", value: null }),
    setup("put", "things", { id: "b" }),
    check("list", "things", { where: { value: null } }),
  ]),
  scenario("sorting-and-pagination", [
    setup("put", "things", { id: "a", rank: 3 }),
    setup("put", "things", { id: "b", rank: 1 }),
    setup("put", "things", { id: "c", rank: 2 }),
    check("list", "things", { sortBy: "rank", offset: 1, limit: 1 }),
    check("list", "things", { sortBy: "rank", sortDir: "desc" }),
  ]),
  scenario("count-honors-markdown-pagination", [
    setup("put", "things", { id: "a" }),
    setup("put", "things", { id: "b" }),
    check("count", "things", { limit: 1 }),
    check("count", "things", { offset: 1 }),
    check("list", "things", { limit: -1 }),
  ]),
  scenario("null-sort-values-last", [
    setup("put", "things", { id: "a", rank: null }),
    setup("put", "things", { id: "b", rank: 1 }),
    setup("put", "things", { id: "c" }),
    check("list", "things", { sortBy: "rank" }),
    check("list", "things", { sortBy: "rank", sortDir: "desc" }),
  ]),
  scenario(
    "collection-directory",
    [
      setup("put", "things", { id: "a" }),
      check("files"),
      check("getById", "things", "a"),
    ],
    { collections: { things: { directory: "records/items" } } }
  ),
  scenario(
    "body-field",
    [
      setup("put", "things", {
        id: "a",
        title: "Hello",
        content: "  A body.  ",
      }),
      check("getById", "things", "a"),
      check("fileContains", "things/a.md", "A body."),
      check("fileContains", "things/a.md", "content:"),
    ],
    { collections: { things: { body: { field: "content" } } } }
  ),
  scenario(
    "body-must-be-text",
    [failure("put", "things", { id: "a", content: [1] })],
    { collections: { things: { body: { field: "content" } } } }
  ),
  scenario(
    "preamble-and-sections",
    [
      setup("put", "documents", note()),
      check("getById", "documents", "note-1"),
      check(
        "fileContains",
        "docs/first-note.md",
        "## Details\n\nDetails here."
      ),
      check("fileContains", "docs/INDEX.md", "- note-1 · First Note · draft"),
    ],
    { preset: "notes" }
  ),
  scenario(
    "manual-edits-are-live",
    [
      setup("put", "documents", note()),
      setup(
        "writeFile",
        "docs/first-note.md",
        "---\nid: note-1\ntitle: Hand edited\nstatus: ready\nunknown: preserved\n---\n\nManual opening.\n\n## Details\n\nManual details.\n\n## Notes\n\nKeep this prose.\n"
      ),
      check("getById", "documents", "note-1"),
      setup("put", "documents", note({ title: "Renamed", status: "done" })),
      check("getById", "documents", "note-1"),
      check(
        "fileContains",
        "docs/first-note.md",
        "## Notes\n\nKeep this prose."
      ),
      check("files"),
    ],
    { preset: "notes" }
  ),
  scenario(
    "unknown-frontmatter-and-comments-survive",
    [
      setup(
        "writeFile",
        "docs/first-note.md",
        "---\n# human comment\nid: note-1\ntitle: First Note\nstatus: draft\ncustom: keep # inline comment\n---\n\n## Notes\n\nPreserved.\n"
      ),
      setup("put", "documents", note({ status: "done" })),
      check("fileContains", "docs/first-note.md", "# human comment"),
      check("fileContains", "docs/first-note.md", "# inline comment"),
      check("getById", "documents", "note-1"),
    ],
    { preset: "notes" }
  ),
  scenario(
    "configured-absent-frontmatter-is-removed",
    [
      setup("put", "documents", note()),
      setup("put", "documents", {
        id: "note-1",
        title: "First Note",
        summary: "Opening",
        details: "Text",
      }),
      check("getById", "documents", "note-1"),
    ],
    { preset: "notes" }
  ),
  scenario(
    "custom-filename-collision",
    [
      setup("put", "documents", note()),
      failure("put", "documents", note({ id: "note-2" })),
      check("count", "documents"),
    ],
    { preset: "notes" }
  ),
  scenario(
    "custom-index-filename-is-reserved",
    [failure("put", "documents", note({ title: "Catalog" })), check("files")],
    { preset: "notes", indexFileName: "catalog.md" }
  ),
  scenario(
    "custom-index-casefold-name-is-reserved",
    [failure("put", "documents", note({ title: "Catalog" })), check("files")],
    { preset: "notes", indexFileName: "Catalog.md" }
  ),
  scenario(
    "custom-index-expanded-casefold-is-reserved",
    [failure("put", "documents", note({ title: "SS" })), check("files")],
    { preset: "notes", indexFileName: "ß.md" }
  ),
  scenario(
    "custom-index-cannot-escape-root",
    [failure("put", "documents", note()), check("files")],
    { preset: "notes", indexFileName: "../../outside.md" }
  ),
  scenario(
    "custom-index-cannot-cross-collections",
    [failure("put", "documents", note()), check("files")],
    { preset: "notes", indexFileName: "../other.md" }
  ),
  scenario(
    "custom-index-filename-cannot-be-empty",
    [failure("put", "documents", note()), check("files")],
    { preset: "notes", indexFileName: "" }
  ),
  scenario(
    "custom-index-cannot-replace-existing-record",
    [
      setup(
        "writeFile",
        "docs/catalog.md",
        "---\nid: existing\ntitle: Keep this\n---\n"
      ),
      failure("put", "documents", note()),
      check("files"),
      check("fileContains", "docs/catalog.md", "id: existing"),
    ],
    { preset: "notes", indexFileName: "catalog.md" }
  ),
  scenario(
    "custom-index-rejects-malformed-record",
    [
      setup("writeFile", "docs/catalog.md", "---\nid: [\n---\n"),
      failure("put", "documents", note()),
      check("files"),
      check("fileContains", "docs/catalog.md", "id: ["),
    ],
    { preset: "notes", indexFileName: "catalog.md" }
  ),
  scenario(
    "index-updates-after-remove",
    [
      setup("put", "documents", note()),
      setup("remove", "documents", "note-1"),
      check("fileContains", "docs/INDEX.md", "note-1"),
      check("fileContains", "docs/INDEX.md", "# Notes"),
      check("files"),
    ],
    { preset: "notes" }
  ),
  scenario("yaml-core-scalars", [
    setup(
      "writeFile",
      "things/a.md",
      "---\nid: a\nyesWord: yes\nonWord: on\ntruth: true\nempty: null\nnumber: 1_000\ncreated: 2024-01-02\nscientific: 1e3\noctal: 0o10\n---\n"
    ),
    check("getById", "things", "a"),
  ]),
  scenario("unicode-record-data", [
    setup("put", "things", {
      id: "🌱",
      title: "Café",
      nested: { flag: true, values: [1, "x"] },
    }),
    check("getById", "things", "🌱"),
  ]),
  scenario("bom-is-accepted", [
    setup("writeFile", "things/a.md", "\ufeff---\nid: a\nvalue: 1\n---\n"),
    check("getById", "things", "a"),
  ]),
  scenario("crlf-opening-is-rejected", [
    setup("writeFile", "things/a.md", "---\r\nid: a\r\n---\r\n"),
    failure("getById", "things", "a"),
  ]),
  scenario("all-corrupt-records-are-reported", [
    setup("put", "things", { id: "valid" }),
    setup("writeFile", "things/broken.md", "not a document"),
    setup("writeFile", "things/also-broken.md", "---\nid: [\n---\n"),
    failure("list", "things"),
  ]),
  scenario("missing-id-is-corrupt", [
    setup("writeFile", "things/a.md", "---\ntitle: Missing id\n---\n"),
    failure("getById", "things", "a"),
  ]),
  scenario(
    "configured-directory-cannot-escape",
    [failure("put", "things", { id: "a" })],
    { collections: { things: { directory: "../outside" } } }
  ),
];
