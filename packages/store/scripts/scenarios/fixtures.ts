// ─── Scenarios: authored data (`@mirk/fixtures`) ────────────────────────────
// The `fixtures` port: a loader built over the scenario's backend store. Every
// scenario begins with `configure(spec)`, a pure-DATA description of the fixture
// types and the source layers — which is what lets Python replay it. A type
// declares its shape with a JSON Schema document and its merge strategy by
// builtin name; the four function hooks (custom `mergeStrategy`,
// `validateReferences`, `extractReferences`, `materialize`) are code, cannot
// cross a language boundary, and stay in each language's own tests.
//
// Sources are `memory` (the deterministic reference: a path→text map) and
// `store` (rows written through the backend store first, so the SQLite adapter
// and the in-memory reference both run the real store source).
//
// Validation is compared by PATHS, never by message: Ajv and Python's
// `jsonschema` word every message differently. See the `invalidPaths` expect
// form in src/conformance/format.ts.
//
// Numbering in the comments refers to the assertion list in
// docs/python-port/digests/fixtures.md §13.

import { defineScenario } from "../../src/conformance/define.js";

// ── Authoring helpers ───────────────────────────────────────────────────────

/** A memory source layer. Values are authored as JSON values and serialized
 *  here, so a scenario reads as documents rather than as escaped text. */
function memory(
  name: string,
  priority: number,
  files: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, string> = {};
  for (const [path, body] of Object.entries(files)) {
    out[path] = typeof body === "string" ? body : JSON.stringify(body);
  }
  return { kind: "memory", name, priority, files: out };
}

/** A store source layer. Each item is written through the backend store before
 *  the source is built. */
function storeSource(
  name: string,
  priority: number,
  collection: string,
  items: Array<Record<string, unknown>>,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const mapped = items.map((item) => ({
    ...item,
    content: typeof item.content === "string" ? item.content : JSON.stringify(item.content),
  }));
  return { kind: "store", name, priority, collection, items: mapped, ...extra };
}

function type(
  name: string,
  directory: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { type: name, directory, ...extra };
}

interface Step {
  op: string;
  args: unknown[];
  expect?:
    | { value: true }
    | { throws: true }
    | { invalidPaths: true }
    | { ignoreFields: string[] };
}

function scenario(
  id: string,
  title: string,
  spec: Record<string, unknown>,
  steps: Step[],
) {
  return defineScenario({
    id: `fixtures/${id}`,
    title,
    ports: ["fixtures"],
    steps: [{ op: "configure", args: [spec] }, ...steps],
  });
}

/** A `configure` that is itself the assertion: the registry rejects the spec. */
function configureThrows(id: string, title: string, spec: Record<string, unknown>) {
  return defineScenario({
    id: `fixtures/${id}`,
    title,
    ports: ["fixtures"],
    steps: [{ op: "configure", args: [spec], expect: { throws: true } }],
  });
}

const value = { value: true } as const;
const throws = { throws: true } as const;
const invalidPaths = { invalidPaths: true } as const;

/** The theme shape most scenarios reuse: an object with a required string
 *  `name`. Enough to make validation observable without restating a schema in
 *  every scenario. */
const THEME_SCHEMA = {
  type: "object",
  required: ["name"],
  properties: { name: { type: "string" } },
};

export const scenarios = [
  // ── Registry (items 1, 2, and the new no-contract rejection) ──────────────
  scenario(
    "registry/types-sorted-by-code-point",
    "types() sorts registered type names by code point, whatever order they were registered in",
    {
      types: [type("zeta", "zeta"), type("alpha", "alpha"), type("Beta", "beta")],
      sources: [memory("pack", 0, {})],
    },
    [{ op: "types", args: [], expect: value }],
  ),
  configureThrows(
    "registry/duplicate-type-rejected",
    "registering the same type twice throws duplicate-type",
    {
      types: [type("theme", "themes"), type("theme", "other")],
      sources: [memory("pack", 0, {})],
    },
  ),
  configureThrows(
    "registry/type-without-any-schema-rejected",
    "a type declaring neither jsonSchema nor schema is rejected at registration",
    {
      types: [{ type: "theme", directory: "themes", jsonSchema: null }],
      sources: [memory("pack", 0, {})],
    },
  ),

  // ── One file, one fixture: matching (items 17, 72, 73) ────────────────────
  scenario(
    "matching/id-is-basename-without-extension",
    "a fixture id is the file basename with the matched extension removed",
    {
      types: [type("theme", "themes")],
      sources: [memory("pack", 0, { "themes/dark.json": { name: "Dark" } })],
    },
    [
      { op: "list", args: [], expect: value },
      { op: "load", args: ["theme:dark"], expect: value },
    ],
  ),
  scenario(
    "matching/nested-paths-are-not-recursed",
    "a file below the type directory does not match: the tail must contain no slash",
    {
      types: [type("theme", "themes")],
      sources: [
        memory("pack", 0, {
          "themes/dark.json": { name: "Dark" },
          "themes/nested/deep.json": { name: "Deep" },
        }),
      ],
    },
    [
      { op: "list", args: [], expect: value },
      { op: "load", args: ["theme:deep"], expect: throws },
    ],
  ),
  scenario(
    "matching/root-directory-matches-source-root",
    'directory "" matches files at the source root (item 73)',
    {
      types: [type("theme", "")],
      sources: [memory("pack", 0, { "dark.json": { name: "Dark" }, "nested/x.json": { name: "X" } })],
    },
    [{ op: "list", args: [], expect: value }],
  ),
  scenario(
    "matching/slash-directory-matches-source-root",
    'directory "/" also means the source root (item 73)',
    {
      types: [type("theme", "/")],
      sources: [memory("pack", 0, { "dark.json": { name: "Dark" } })],
    },
    [{ op: "list", args: [], expect: value }],
  ),
  scenario(
    "matching/extension-match-is-a-suffix",
    "extension matching is endsWith, so a.min.json under [.json] is the fixture a.min (item 72)",
    {
      types: [type("theme", "themes", { extensions: [".json"] })],
      sources: [memory("pack", 0, { "themes/a.min.json": { name: "A" } })],
    },
    [{ op: "list", args: [], expect: value }],
  ),
  scenario(
    "matching/empty-id-is-not-a-fixture",
    "a file whose whole name is the extension has an empty id and is not a fixture",
    {
      types: [type("theme", "themes")],
      sources: [memory("pack", 0, { "themes/.json": { name: "Hidden" }, "themes/a.json": { name: "A" } })],
    },
    [{ op: "list", args: [], expect: value }],
  ),
  scenario(
    "matching/unparsed-extension-reports-one-diagnostic",
    "a file under the directory with no registered parser yields exactly one no-parser diagnostic (item 17)",
    {
      types: [type("theme", "themes")],
      sources: [
        memory("pack", 0, {
          "themes/dark.yaml": "name: Dark",
          "themes/nested/ignored.yaml": "name: Ignored",
          "other/dark.yaml": "name: Other",
          "themes/ok.json": { name: "Ok" },
        }),
      ],
    },
    [{ op: "validate", args: [], expect: value }],
  ),
  scenario(
    "matching/unknown-type-is-not-found",
    "loading an unregistered type throws unknown-type",
    {
      types: [type("theme", "themes")],
      sources: [memory("pack", 0, { "themes/dark.json": { name: "Dark" } })],
    },
    [{ op: "load", args: ["widget:dark"], expect: throws }],
  ),
  scenario(
    "matching/missing-fixture-is-not-found",
    "loading a fixture no source carries throws not-found",
    {
      types: [type("theme", "themes")],
      sources: [memory("pack", 0, { "themes/dark.json": { name: "Dark" } })],
    },
    [{ op: "load", args: ["theme:light"], expect: throws }],
  ),

  // ── Ref grammar (parsing, not the graph) ────────────────────────────────────
  scenario(
    "ref-grammar/malformed-ref-is-rejected",
    "a ref with two colons is not a ref: the whole string is checked",
    {
      types: [type("theme", "themes")],
      sources: [memory("pack", 0, { "themes/dark.json": { name: "Dark" } })],
    },
    [{ op: "load", args: ["theme:a:b"], expect: throws }],
  ),
  scenario(
    "ref-grammar/whitespace-in-id-is-rejected",
    "an id containing whitespace anywhere is not a valid ref",
    {
      types: [type("theme", "themes")],
      sources: [memory("pack", 0, { "themes/dark.json": { name: "Dark" } })],
    },
    [{ op: "load", args: ["theme:a b"], expect: throws }],
  ),
  scenario(
    "ref-grammar/empty-type-is-rejected",
    "a leading colon is not a ref",
    {
      types: [type("theme", "themes")],
      sources: [memory("pack", 0, { "themes/dark.json": { name: "Dark" } })],
    },
    [{ op: "load", args: [":dark"], expect: throws }],
  ),

  // ── Keyed map documents (items 3-9) ──────────────────────────────────────
  scenario(
    "map/one-document-many-fixtures",
    "a map document yields one independently addressable fixture per top-level key (item 3)",
    {
      types: [type("theme", "themes", { document: { kind: "map", idField: "id" } })],
      sources: [
        memory("pack", 0, {
          "themes/core.json": { dark: { name: "Dark" }, light: { id: "light", name: "Light" } },
        }),
      ],
    },
    [
      { op: "list", args: ["theme"], expect: value },
      { op: "load", args: ["theme:dark"], expect: value },
      { op: "load", args: ["theme:light"], expect: value },
    ],
  ),
  scenario(
    "map/id-field-injected-first",
    "the map key is injected into idField when absent, and prepended (item 4)",
    {
      types: [type("theme", "themes", { document: { kind: "map", idField: "id" } })],
      sources: [memory("pack", 0, { "themes/core.json": { dark: { name: "Dark" } } })],
    },
    [{ op: "load", args: ["theme:dark"], expect: value }],
  ),
  scenario(
    "map/id-field-not-injected-without-id-field",
    "with no idField the entry value is untouched and may be any JSON value",
    {
      types: [type("theme", "themes", { document: { kind: "map" } })],
      sources: [memory("pack", 0, { "themes/core.json": { dark: [1, 2], light: "plain" } })],
    },
    [
      { op: "load", args: ["theme:dark"], expect: value },
      { op: "load", args: ["theme:light"], expect: value },
    ],
  ),
  scenario(
    "map/patch-entry-patches-one-key",
    "a $patch entry in a higher layer patches only its own key (item 5)",
    {
      types: [
        type("theme", "themes", { document: { kind: "map", idField: "id" }, mergeStrategy: "deep" }),
      ],
      sources: [
        memory("base", 0, {
          "themes/core.json": { dark: { name: "Dark", accent: "blue" }, light: { name: "Light" } },
        }),
        memory("overrides", 1, {
          "themes/core.json": { dark: { $patch: "theme:dark", accent: "red" } },
        }),
      ],
    },
    [
      { op: "load", args: ["theme:dark"], expect: value },
      { op: "load", args: ["theme:light"], expect: value },
    ],
  ),
  scenario(
    "map/provenance-carries-the-key-suffix",
    "provenance paths for a map fixture are <file>#<key>, in layer order (item 6)",
    {
      types: [
        type("theme", "themes", { document: { kind: "map", idField: "id" }, mergeStrategy: "deep" }),
      ],
      sources: [
        memory("base", 0, { "themes/core.json": { dark: { name: "Dark" } } }),
        memory("overrides", 1, {
          "themes/overrides.json": { dark: { $patch: "theme:dark", accent: "red" } },
        }),
      ],
    },
    [{ op: "explain", args: ["theme:dark"], expect: value }],
  ),
  scenario(
    "map/pack-validates-clean",
    "a well-formed map pack validates with no diagnostics (item 7)",
    {
      types: [
        type("theme", "themes", {
          document: { kind: "map", idField: "id" },
          jsonSchema: THEME_SCHEMA,
        }),
      ],
      sources: [
        memory("pack", 0, { "themes/core.json": { dark: { name: "Dark" }, light: { name: "Light" } } }),
      ],
    },
    [{ op: "validate", args: [], expect: value }],
  ),
  scenario(
    "map/base-id-mismatch-rejected",
    "a base map entry whose explicit id disagrees with its key throws map-id-mismatch (item 8)",
    {
      types: [type("theme", "themes", { document: { kind: "map", idField: "id" } })],
      sources: [memory("pack", 0, { "themes/core.json": { dark: { id: "other", name: "Dark" } } })],
    },
    [{ op: "load", args: ["theme:dark"], expect: throws }],
  ),
  scenario(
    "map/patch-id-mismatch-rejected",
    "a PATCH map entry whose explicit id disagrees with its key throws map-id-mismatch (item 9)",
    {
      types: [type("theme", "themes", { document: { kind: "map", idField: "id" } })],
      sources: [
        memory("base", 0, { "themes/core.json": { dark: { name: "Dark" } } }),
        memory("overrides", 1, {
          "themes/overrides.json": { dark: { $patch: "theme:dark", id: "other" } },
        }),
      ],
    },
    [{ op: "load", args: ["theme:dark"], expect: throws }],
  ),
  scenario(
    "map/non-object-document-rejected",
    "a map type whose document parses to an array throws invalid-map-document",
    {
      types: [type("theme", "themes", { document: { kind: "map", idField: "id" } })],
      sources: [memory("pack", 0, { "themes/core.json": [{ name: "Dark" }] })],
    },
    [{ op: "load", args: ["theme:dark"], expect: throws }],
  ),
  scenario(
    "map/non-object-entry-rejected-with-id-field",
    "with idField set, a non-object map entry throws invalid-map-fixture",
    {
      types: [type("theme", "themes", { document: { kind: "map", idField: "id" } })],
      sources: [memory("pack", 0, { "themes/core.json": { dark: "plain" } })],
    },
    [{ op: "load", args: ["theme:dark"], expect: throws }],
  ),

  // ── Layering and patches (items 10-16, 71, 75, 76, 78) ───────────────────
  scenario(
    "layering/patch-merges-over-base",
    "a base in a low layer plus a $patch in a high layer produces the merged value (item 10)",
    {
      types: [type("theme", "themes", { mergeStrategy: "deep" })],
      sources: [
        memory("base", 0, { "themes/dark.json": { name: "Dark", palette: { fg: "white" } } }),
        memory("overrides", 1, {
          "themes/dark.json": { $patch: "theme:dark", palette: { bg: "black" } },
        }),
      ],
    },
    [{ op: "load", args: ["theme:dark"], expect: value }],
  ),
  scenario(
    "layering/provenance-base-then-patch",
    "provenance kinds are [base, patch] with the file path on both (item 11)",
    {
      types: [type("theme", "themes", { mergeStrategy: "deep" })],
      sources: [
        memory("base", 0, { "themes/dark.json": { name: "Dark" } }),
        memory("overrides", 1, { "themes/dark.json": { $patch: "theme:dark", accent: "red" } }),
      ],
    },
    [{ op: "explain", args: ["theme:dark"], expect: value }],
  ),
  scenario(
    "layering/shadowed-patch-ref-mismatch-still-fires",
    "a $patch naming another ref throws even when it sits below the selected base (item 12)",
    {
      types: [type("theme", "themes")],
      sources: [
        memory("low", 0, { "themes/dark.json": { $patch: "theme:other", accent: "red" } }),
        memory("high", 1, { "themes/dark.json": { name: "Dark" } }),
      ],
    },
    [{ op: "load", args: ["theme:dark"], expect: throws }],
  ),
  scenario(
    "layering/patch-at-base-priority-does-not-apply",
    "a patch at or below the base's priority does not apply; the value is the base alone (item 13)",
    {
      types: [type("theme", "themes", { mergeStrategy: "deep" })],
      sources: [
        { ...memory("base", 5, { "themes/dark.json": { name: "Dark" } }) },
        { ...memory("same", 5, { "themes/dark.json": { $patch: "theme:dark", accent: "red" } }) },
      ],
    },
    [
      { op: "load", args: ["theme:dark"], expect: value },
      { op: "explain", args: ["theme:dark"], expect: value },
    ],
  ),
  scenario(
    "layering/patches-without-a-base-are-rejected",
    "a pack of patches with no full document throws patch-without-base (item 15)",
    {
      types: [type("theme", "themes")],
      sources: [memory("pack", 0, { "themes/dark.json": { $patch: "theme:dark", accent: "red" } })],
    },
    [{ op: "load", args: ["theme:dark"], expect: throws }],
  ),
  scenario(
    "layering/patch-above-base-ref-mismatch",
    "a patch above the base naming a different ref throws patch-ref-mismatch (item 16)",
    {
      types: [type("theme", "themes")],
      sources: [
        memory("base", 0, { "themes/dark.json": { name: "Dark" } }),
        memory("overrides", 1, { "themes/dark.json": { $patch: "theme:other", accent: "red" } }),
      ],
    },
    [{ op: "load", args: ["theme:dark"], expect: throws }],
  ),
  scenario(
    "layering/higher-base-replaces-lower-base",
    "two full documents do not merge: the highest-priority one replaces the other outright",
    {
      types: [type("theme", "themes", { mergeStrategy: "deep" })],
      sources: [
        memory("base", 0, { "themes/dark.json": { name: "Dark", accent: "blue" } }),
        memory("override", 1, { "themes/dark.json": { name: "Darker" } }),
      ],
    },
    [
      { op: "load", args: ["theme:dark"], expect: value },
      { op: "explain", args: ["theme:dark"], expect: value },
    ],
  ),
  scenario(
    "layering/shadowed-base-is-never-validated",
    "a base a higher layer replaced is never schema-validated, however malformed (item 71)",
    {
      types: [type("theme", "themes", { jsonSchema: THEME_SCHEMA })],
      sources: [
        memory("base", 0, { "themes/dark.json": { name: 42 } }),
        memory("override", 1, { "themes/dark.json": { name: "Dark" } }),
      ],
    },
    [
      { op: "load", args: ["theme:dark"], expect: value },
      { op: "validate", args: [], expect: value },
    ],
  ),
  scenario(
    "layering/declaration-order-breaks-a-priority-tie",
    "sources sharing a priority keep declaration order, so the later declaration is the base",
    {
      types: [type("theme", "themes")],
      sources: [
        { ...memory("first", 3, { "themes/dark.json": { name: "First" } }) },
        { ...memory("second", 3, { "themes/dark.json": { name: "Second" } }) },
      ],
    },
    [
      { op: "load", args: ["theme:dark"], expect: value },
      { op: "explain", args: ["theme:dark"], expect: value },
    ],
  ),
  scenario(
    "layering/patch-cannot-delete-a-key",
    "no strategy removes a key: a deep patch retains what it omits and overwrites with null (items 75, 76)",
    {
      types: [type("theme", "themes", { mergeStrategy: "deep" })],
      sources: [
        memory("base", 0, {
          "themes/dark.json": { name: "Dark", keep: { a: 1 }, drop: { b: 2 } },
        }),
        memory("overrides", 1, { "themes/dark.json": { $patch: "theme:dark", drop: null } }),
      ],
    },
    [{ op: "load", args: ["theme:dark"], expect: value }],
  ),
  // `validate()` degrades where `list()` aborts (item 78). Only the degradation
  // is pinned here, and its message is IGNORED: `parse-failed` wraps the host
  // parser's own words, which V8 and CPython spell differently for the same
  // broken document. That `list()` throws is pinned by every other list-throws
  // scenario in this file, all of which raise a message Mirk itself writes.
  scenario(
    "layering/parse-error-degrades-in-validate",
    "a malformed document is reported by validate() rather than thrown, and the source is skipped (item 78)",
    {
      types: [type("theme", "themes")],
      sources: [
        memory("pack", 0, { "themes/bad.json": "{ not json", "themes/good.json": { name: "Good" } }),
      ],
    },
    [
      {
        op: "validateDiagnostics",
        args: [],
        expect: { ignoreFields: ["message"] },
      },
    ],
  ),

  // ── Merge strategies (items 18-20) ───────────────────────────────────────
  ...(
    [
      ["replace", "replace keeps only the incoming keys (item 18)"],
      ["deep", "deep merges nested objects, replaces arrays, retains omitted keys (item 19)"],
      ["array-replace", "array-replace merges only top-level keys (item 20)"],
    ] as const
  ).map(([strategy, title]) =>
    scenario(
      `merge/${strategy}`,
      title,
      {
        types: [type("theme", "themes", { mergeStrategy: strategy })],
        sources: [
          memory("base", 0, {
            "themes/dark.json": {
              nested: { keep: true, replace: "base" },
              list: ["base"],
              retained: { stable: true },
            },
          }),
          memory("overrides", 1, {
            "themes/dark.json": {
              $patch: "theme:dark",
              nested: { replace: "patch" },
              list: ["patch"],
            },
          }),
        ],
      },
      [{ op: "load", args: ["theme:dark"], expect: value }],
    ),
  ),
  scenario(
    "merge/default-strategy-is-replace",
    "a type declaring no mergeStrategy replaces the value with the patch body",
    {
      types: [type("theme", "themes")],
      sources: [
        memory("base", 0, { "themes/dark.json": { name: "Dark", accent: "blue" } }),
        memory("overrides", 1, { "themes/dark.json": { $patch: "theme:dark", name: "Patched" } }),
      ],
    },
    [{ op: "load", args: ["theme:dark"], expect: value }],
  ),
  scenario(
    "merge/deep-replaces-arrays-at-every-depth",
    "an array is not a plain object, so deep merge replaces it wherever it appears",
    {
      types: [type("theme", "themes", { mergeStrategy: "deep" })],
      sources: [
        memory("base", 0, { "themes/dark.json": { a: { b: [1, 2, 3], c: 1 } } }),
        memory("overrides", 1, { "themes/dark.json": { $patch: "theme:dark", a: { b: [9] } } }),
      ],
    },
    [{ op: "load", args: ["theme:dark"], expect: value }],
  ),
  scenario(
    "merge/deep-scalar-overwrites-an-object",
    "deep merge replaces when either side stops being a plain object",
    {
      types: [type("theme", "themes", { mergeStrategy: "deep" })],
      sources: [
        memory("base", 0, { "themes/dark.json": { a: { b: 1 } } }),
        memory("overrides", 1, { "themes/dark.json": { $patch: "theme:dark", a: 5 } }),
      ],
    },
    [{ op: "load", args: ["theme:dark"], expect: value }],
  ),
  scenario(
    "merge/two-patches-apply-in-priority-order",
    "patches merge in ascending priority, and provenance records each one",
    {
      types: [type("theme", "themes", { mergeStrategy: "deep" })],
      sources: [
        memory("base", 0, { "themes/dark.json": { name: "Dark", step: 0 } }),
        memory("mid", 1, { "themes/dark.json": { $patch: "theme:dark", step: 1, mid: true } }),
        memory("top", 2, { "themes/dark.json": { $patch: "theme:dark", step: 2 } }),
      ],
    },
    [
      { op: "load", args: ["theme:dark"], expect: value },
      { op: "explain", args: ["theme:dark"], expect: value },
    ],
  ),

  // ── References and the graph (items 22-29, 31, 74, 82) ───────────────────
  scenario(
    "references/explicit-ref-resolves",
    "an explicit $ref to an existing fixture validates clean and produces one edge (items 22, 23)",
    {
      types: [type("theme", "themes"), type("page", "pages")],
      sources: [
        memory("pack", 0, {
          "themes/dark.json": { name: "Dark" },
          "pages/home.json": { theme: { $ref: "theme:dark" } },
        }),
      ],
    },
    [
      { op: "validate", args: [], expect: value },
      { op: "referenceGraph", args: [], expect: value },
    ],
  ),
  scenario(
    "references/missing-target-is-one-diagnostic",
    "a $ref to a fixture nothing carries yields one missing-reference diagnostic (items 24, 26)",
    {
      types: [type("theme", "themes"), type("page", "pages")],
      sources: [
        memory("pack", 0, {
          "themes/dark.json": { name: "Dark" },
          "pages/home.json": { theme: { $ref: "theme:missing" } },
        }),
      ],
    },
    [
      { op: "validate", args: [], expect: value },
      { op: "referenceGraph", args: [], expect: value },
    ],
  ),
  scenario(
    "references/bare-string-is-not-a-reference-by-default",
    "under the default mode a canonical-looking string produces no edge (item 25)",
    {
      types: [type("theme", "themes"), type("page", "pages")],
      sources: [
        memory("pack", 0, {
          "themes/dark.json": { name: "Dark" },
          "pages/home.json": { theme: "theme:dark" },
        }),
      ],
    },
    [{ op: "referenceGraph", args: [], expect: value }],
  ),
  scenario(
    "references/bare-string-is-a-reference-under-explicit-and-bare",
    "the loader-level explicit-and-bare mode turns a canonical string into an edge",
    {
      types: [type("theme", "themes"), type("page", "pages")],
      referenceMode: "explicit-and-bare",
      sources: [
        memory("pack", 0, {
          "themes/dark.json": { name: "Dark" },
          "pages/home.json": { theme: "theme:dark" },
        }),
      ],
    },
    [{ op: "referenceGraph", args: [], expect: value }],
  ),
  scenario(
    "references/type-level-mode-overrides-the-loader",
    "a type's own referenceMode wins over the loader's",
    {
      types: [
        type("theme", "themes"),
        type("page", "pages", { referenceMode: "explicit-and-bare" }),
      ],
      sources: [
        memory("pack", 0, {
          "themes/dark.json": { name: "Dark" },
          "pages/home.json": { theme: "theme:dark" },
        }),
      ],
    },
    [{ op: "referenceGraph", args: [], expect: value }],
  ),
  scenario(
    "references/prose-containing-a-ref-is-not-a-reference",
    "bare-ref detection checks the WHOLE string, so prose is never a reference (item 29)",
    {
      types: [type("theme", "themes"), type("page", "pages")],
      referenceMode: "explicit-and-bare",
      sources: [
        memory("pack", 0, {
          "themes/dark.json": { name: "Dark" },
          "pages/home.json": { note: "Use theme:missing in prose only." },
        }),
      ],
    },
    [
      { op: "validate", args: [], expect: value },
      { op: "referenceGraph", args: [], expect: value },
    ],
  ),
  scenario(
    "references/malformed-ref-is-a-graph-diagnostic",
    "a $ref whose value is not a valid ref becomes an invalid-ref diagnostic on the graph (item 31)",
    {
      types: [type("theme", "themes"), type("page", "pages")],
      sources: [
        memory("pack", 0, {
          "themes/dark.json": { name: "Dark" },
          "pages/home.json": { theme: { $ref: "not a ref" } },
        }),
      ],
    },
    [
      { op: "referenceGraph", args: [], expect: value },
      { op: "validate", args: [], expect: value },
    ],
  ),
  scenario(
    "references/ref-object-content-is-not-walked",
    "nested content under a $ref object is invisible to the walk (item 82)",
    {
      types: [type("theme", "themes"), type("page", "pages")],
      sources: [
        memory("pack", 0, {
          "themes/dark.json": { name: "Dark" },
          "themes/light.json": { name: "Light" },
          "pages/home.json": { theme: { $ref: "theme:dark", inner: { $ref: "theme:light" } } },
        }),
      ],
    },
    [{ op: "referenceGraph", args: [], expect: value }],
  ),
  scenario(
    "references/array-indices-appear-in-the-field-path",
    "an array contributes numeric field-path segments",
    {
      types: [type("theme", "themes"), type("page", "pages")],
      sources: [
        memory("pack", 0, {
          "themes/dark.json": { name: "Dark" },
          "themes/light.json": { name: "Light" },
          "pages/home.json": { themes: [{ $ref: "theme:dark" }, { $ref: "theme:light" }] },
        }),
      ],
    },
    [{ op: "referenceGraph", args: [], expect: value }],
  ),
  scenario(
    "references/deeper-than-32-levels-is-invisible",
    "the reference walk stops below depth 32, so a very deep $ref is not extracted (item 74)",
    {
      types: [type("theme", "themes"), type("page", "pages")],
      sources: [
        memory("pack", 0, {
          "themes/dark.json": { name: "Dark" },
          "pages/deep.json": nest(40, { $ref: "theme:dark" }),
          "pages/shallow.json": nest(3, { $ref: "theme:dark" }),
        }),
      ],
    },
    [{ op: "referenceGraph", args: [], expect: value }],
  ),

  // ── resolveRef (items 27, 28) ────────────────────────────────────────────
  scenario(
    "resolve/bare-string-returned-unchanged",
    "resolveRef returns a canonical string unchanged under the default mode (item 27)",
    {
      types: [type("theme", "themes")],
      sources: [memory("pack", 0, { "themes/dark.json": { name: "Dark" } })],
    },
    [{ op: "resolveRef", args: ["theme:dark"], expect: value }],
  ),
  scenario(
    "resolve/bare-string-loads-under-explicit-and-bare",
    "the same call under explicit-and-bare loads the fixture (item 28)",
    {
      types: [type("theme", "themes")],
      referenceMode: "explicit-and-bare",
      sources: [memory("pack", 0, { "themes/dark.json": { name: "Dark" } })],
    },
    [{ op: "resolveRef", args: ["theme:dark"], expect: value }],
  ),
  scenario(
    "resolve/explicit-ref-loads-in-either-mode",
    "an explicit $ref object always loads, whatever the reference mode",
    {
      types: [type("theme", "themes")],
      sources: [memory("pack", 0, { "themes/dark.json": { name: "Dark" } })],
    },
    [{ op: "resolveRef", args: [{ $ref: "theme:dark" }], expect: value }],
  ),
  scenario(
    "resolve/type-mismatch-is-rejected",
    "resolveRef with an expectedType that disagrees with the ref throws type-mismatch",
    {
      types: [type("theme", "themes"), type("page", "pages")],
      sources: [memory("pack", 0, { "themes/dark.json": { name: "Dark" } })],
    },
    [{ op: "resolveRef", args: [{ $ref: "theme:dark" }, "page"], expect: throws }],
  ),
  scenario(
    "resolve/inline-value-is-validated-against-the-expected-type",
    "an inline value with an expectedType is validated and returned",
    {
      types: [type("theme", "themes", { jsonSchema: THEME_SCHEMA })],
      sources: [memory("pack", 0, { "themes/dark.json": { name: "Dark" } })],
    },
    [{ op: "resolveRef", args: [{ name: "Inline" }, "theme"], expect: value }],
  ),
  scenario(
    "resolve/inline-value-without-an-expected-type-passes-through",
    "with no expectedType a non-ref value is returned unchanged",
    {
      types: [type("theme", "themes")],
      sources: [memory("pack", 0, { "themes/dark.json": { name: "Dark" } })],
    },
    [{ op: "resolveRef", args: [{ any: [1, null, "x"] }], expect: value }],
  ),

  // ── Validation, compared by instance path ────────────────────────────────
  scenario(
    "validation/clean-pass",
    "a pack satisfying its schema validates with no diagnostics",
    {
      types: [type("theme", "themes", { jsonSchema: THEME_SCHEMA })],
      sources: [
        memory("pack", 0, {
          "themes/dark.json": { name: "Dark" },
          "themes/light.json": { name: "Light" },
        }),
      ],
    },
    [
      { op: "validate", args: [], expect: invalidPaths },
      { op: "validate", args: [], expect: value },
    ],
  ),
  scenario(
    "validation/required-property-missing",
    "a missing required property reports the CONTAINING object's path, not the property",
    {
      types: [type("theme", "themes", { jsonSchema: THEME_SCHEMA })],
      sources: [memory("pack", 0, { "themes/dark.json": { accent: "red" } })],
    },
    [{ op: "validate", args: [], expect: invalidPaths }],
  ),
  scenario(
    "validation/wrong-scalar-type",
    "a property of the wrong type reports that property's path",
    {
      types: [type("theme", "themes", { jsonSchema: THEME_SCHEMA })],
      sources: [memory("pack", 0, { "themes/dark.json": { name: 42 } })],
    },
    [{ op: "validate", args: [], expect: invalidPaths }],
  ),
  scenario(
    "validation/enum-violation",
    "an enum failure reports the property's path",
    {
      types: [
        type("theme", "themes", {
          jsonSchema: {
            type: "object",
            required: ["mode"],
            properties: { mode: { enum: ["light", "dark"] } },
          },
        }),
      ],
      sources: [memory("pack", 0, { "themes/neon.json": { mode: "neon" } })],
    },
    [{ op: "validate", args: [], expect: invalidPaths }],
  ),
  scenario(
    "validation/pattern-violation",
    "a pattern failure reports the property's path",
    {
      types: [
        type("theme", "themes", {
          jsonSchema: {
            type: "object",
            required: ["accent"],
            properties: { accent: { type: "string", pattern: "^#[0-9a-fA-F]{6}$" } },
          },
        }),
      ],
      sources: [
        memory("pack", 0, {
          "themes/bad.json": { accent: "red" },
          "themes/good.json": { accent: "#AABBCC" },
        }),
      ],
    },
    [{ op: "validate", args: [], expect: invalidPaths }],
  ),
  scenario(
    "validation/nested-object-failure",
    "a failure inside a nested object reports the full dotted path",
    {
      types: [
        type("theme", "themes", {
          jsonSchema: {
            type: "object",
            required: ["palette"],
            properties: {
              palette: {
                type: "object",
                required: ["fg"],
                properties: { fg: { type: "string" }, bg: { type: "string" } },
              },
            },
          },
        }),
      ],
      sources: [memory("pack", 0, { "themes/dark.json": { palette: { fg: 1, bg: 2 } } })],
    },
    [{ op: "validate", args: [], expect: invalidPaths }],
  ),
  scenario(
    "validation/array-item-failure",
    "an item failure reports its index as a path segment",
    {
      types: [
        type("theme", "themes", {
          jsonSchema: {
            type: "object",
            required: ["swatches"],
            properties: {
              swatches: {
                type: "array",
                minItems: 1,
                items: { type: "object", required: ["hex"], properties: { hex: { type: "string" } } },
              },
            },
          },
        }),
      ],
      sources: [
        memory("pack", 0, {
          "themes/dark.json": { swatches: [{ hex: "#000000" }, { hex: 5 }, {}] },
        }),
      ],
    },
    [{ op: "validate", args: [], expect: invalidPaths }],
  ),
  scenario(
    "validation/any-of-reports-leaf-paths-only",
    "an anyOf failure contributes its branch paths; the aggregate keyword path is excluded",
    {
      types: [
        type("theme", "themes", {
          jsonSchema: {
            type: "object",
            required: ["label"],
            properties: { label: { anyOf: [{ const: false }, { type: "string" }] } },
          },
        }),
      ],
      sources: [memory("pack", 0, { "themes/dark.json": { label: 3 } })],
    },
    [{ op: "validate", args: [], expect: invalidPaths }],
  ),
  scenario(
    "validation/if-then-conditional",
    "an if/then failure reports the then-branch path, never the if keyword's",
    {
      types: [
        type("theme", "themes", {
          jsonSchema: {
            type: "object",
            required: ["mode"],
            properties: { mode: { type: "string" }, accent: { type: "string" } },
            if: { properties: { mode: { const: "dark" } }, required: ["mode"] },
            then: { required: ["accent"] },
          },
        }),
      ],
      sources: [
        memory("pack", 0, {
          "themes/dark.json": { mode: "dark" },
          "themes/light.json": { mode: "light" },
        }),
      ],
    },
    [{ op: "validate", args: [], expect: invalidPaths }],
  ),
  scenario(
    "validation/whole-document-failure-has-an-empty-path",
    "a failure of the document itself reports the empty instance path",
    {
      types: [type("theme", "themes", { jsonSchema: { type: "object" } })],
      sources: [memory("pack", 0, { "themes/dark.json": [1, 2] })],
    },
    [{ op: "validate", args: [], expect: invalidPaths }],
  ),
  scenario(
    "validation/many-fixtures-report-per-fixture-paths",
    "each failing fixture contributes its own <ref>#<path> entries",
    {
      types: [type("theme", "themes", { jsonSchema: THEME_SCHEMA })],
      sources: [
        memory("pack", 0, {
          "themes/a.json": { name: 1 },
          "themes/b.json": {},
          "themes/c.json": { name: "Fine" },
        }),
      ],
    },
    [{ op: "validate", args: [], expect: invalidPaths }],
  ),
  scenario(
    "validation/single-ref-validation",
    "validate(ref) checks exactly that fixture",
    {
      types: [type("theme", "themes", { jsonSchema: THEME_SCHEMA })],
      sources: [
        memory("pack", 0, { "themes/a.json": { name: 1 }, "themes/b.json": { name: 2 } }),
      ],
    },
    [{ op: "validate", args: ["theme:a"], expect: invalidPaths }],
  ),
  scenario(
    "validation/patch-result-is-revalidated",
    "the merged value is validated after every patch, so a patch that breaks the shape fails",
    {
      types: [type("theme", "themes", { jsonSchema: THEME_SCHEMA, mergeStrategy: "deep" })],
      sources: [
        memory("base", 0, { "themes/dark.json": { name: "Dark" } }),
        memory("overrides", 1, { "themes/dark.json": { $patch: "theme:dark", name: 9 } }),
      ],
    },
    [{ op: "validate", args: [], expect: invalidPaths }],
  ),
  scenario(
    "validation/boolean-true-schema-accepts-anything",
    "jsonSchema true is the contract that accepts every document",
    {
      types: [type("theme", "themes", { jsonSchema: true })],
      sources: [memory("pack", 0, { "themes/dark.json": [1, "two", null] })],
    },
    [
      { op: "load", args: ["theme:dark"], expect: value },
      { op: "validate", args: [], expect: invalidPaths },
    ],
  ),
  scenario(
    "validation/boolean-false-schema-rejects-everything",
    "jsonSchema false rejects every document, at the empty instance path",
    {
      types: [type("theme", "themes", { jsonSchema: false })],
      sources: [memory("pack", 0, { "themes/dark.json": { name: "Dark" } })],
    },
    [{ op: "validate", args: [], expect: invalidPaths }],
  ),

  // ── Store source and sink (items 35, 36, 39-43) ──────────────────────────
  scenario(
    "store/locator-is-never-parsed",
    "a store item is matched by relativePath; its id is an opaque locator (item 35)",
    {
      types: [type("theme", "themes")],
      sources: [
        storeSource("db", 0, "fixture_docs", [
          {
            id: "item.with.dots/and/slash.json",
            relativePath: "themes/store-theme.json",
            content: { name: "Stored" },
          },
        ]),
      ],
    },
    [
      { op: "list", args: [], expect: value },
      { op: "load", args: ["theme:store-theme"], expect: value },
    ],
  ),
  scenario(
    "store/path-prefix-applies-only-without-an-explicit-path",
    "an explicit relativePath ignores pathPrefix; without one the path is <prefix>/<id><ext> (item 36)",
    {
      types: [type("theme", "themes")],
      sources: [
        storeSource(
          "db",
          0,
          "fixture_docs",
          [
            { id: "derived", content: { name: "Derived" } },
            { id: "explicit", relativePath: "themes/explicit.json", content: { name: "Explicit" } },
          ],
          { pathPrefix: "themes" },
        ),
      ],
    },
    [
      { op: "list", args: [], expect: value },
      { op: "load", args: ["theme:derived"], expect: value },
      { op: "load", args: ["theme:explicit"], expect: value },
    ],
  ),
  scenario(
    "store/entries-sort-by-relative-path",
    "store entries list in code point order of the relative path",
    {
      types: [type("theme", "themes")],
      sources: [
        storeSource(
          "db",
          0,
          "fixture_docs",
          [
            { id: "zulu", content: { name: "Zulu" } },
            { id: "Alpha", content: { name: "Alpha" } },
            { id: "alpha", content: { name: "alpha" } },
          ],
          { pathPrefix: "themes" },
        ),
      ],
    },
    [{ op: "list", args: [], expect: value }],
  ),
  // Source-entry order is observable in exactly one place: which of several
  // competing errors a broken pack raises first (digest §4.4). "Z" sorts before
  // "a" by code point and after it under ICU collation, so these two scenarios
  // are what a locale-aware comparator would fail.
  scenario(
    "store/entry-order-is-code-point-not-collation",
    "a store source visits Z before a, so the first defect raised is the one in Z",
    {
      types: [type("theme", "themes", { document: { kind: "map", idField: "id" } })],
      sources: [
        storeSource("db", 0, "fixture_docs", [
          { id: "upper", relativePath: "themes/Z.json", content: [1] },
          { id: "lower", relativePath: "themes/a.json", content: { one: { id: "other" } } },
        ]),
      ],
    },
    [{ op: "list", args: [], expect: throws }],
  ),
  scenario(
    "store/memory-and-store-sources-agree-on-order",
    "a memory source visits the same two paths in the same order as a store source",
    {
      types: [type("theme", "themes", { document: { kind: "map", idField: "id" } })],
      sources: [
        memory("files", 0, { "themes/Z.json": [1], "themes/a.json": { one: { id: "other" } } }),
      ],
    },
    [{ op: "list", args: [], expect: throws }],
  ),
  scenario(
    "store/unsafe-relative-path-is-rejected",
    "a store item whose relativePath escapes the source throws unsafe-relative-path (item 39)",
    {
      types: [type("theme", "themes")],
      sources: [
        storeSource("db", 0, "fixture_docs", [
          { id: "escape", relativePath: "../outside.json", content: { name: "Nope" } },
        ]),
      ],
    },
    [{ op: "list", args: [], expect: throws }],
  ),
  scenario(
    "store/duplicate-relative-paths-are-rejected",
    "two rows producing the same relative path throw duplicate-relative-path (item 40)",
    {
      types: [type("theme", "themes")],
      sources: [
        storeSource("db", 0, "fixture_docs", [
          { id: "one", relativePath: "themes/dark.json", content: { name: "One" } },
          { id: "two", relativePath: "themes/dark.json", content: { name: "Two" } },
        ]),
      ],
    },
    [{ op: "list", args: [], expect: throws }],
  ),
  scenario(
    "store/layers-with-a-memory-source",
    "a store source layers against a memory source by priority like any other",
    {
      types: [type("theme", "themes", { mergeStrategy: "deep" })],
      sources: [
        memory("files", 0, { "themes/dark.json": { name: "Dark", accent: "blue" } }),
        storeSource(
          "db",
          1,
          "fixture_docs",
          [{ id: "dark", content: { $patch: "theme:dark", accent: "red" } }],
          { pathPrefix: "themes" },
        ),
      ],
    },
    [
      { op: "load", args: ["theme:dark"], expect: value },
      { op: "explain", args: ["theme:dark"], expect: value },
    ],
  ),
  scenario(
    "store/seed-writes-each-fixture",
    "seedStoreFromFixtures writes every fixture of every target into its collection (item 41)",
    {
      types: [type("theme", "themes", { jsonSchema: THEME_SCHEMA })],
      sources: [
        memory("pack", 0, {
          "themes/dark.json": { name: "Dark" },
          "themes/light.json": { name: "Light" },
        }),
      ],
    },
    [
      { op: "seedStore", args: [{ targets: { theme: "themes" } }], expect: value },
      { op: "readSeeded", args: ["themes", "dark"], expect: value },
      { op: "readSeeded", args: ["themes", "light"], expect: value },
    ],
  ),
  scenario(
    "store/seed-can-carry-provenance",
    "includeProvenance stores the layer stack alongside the value (item 41)",
    {
      types: [type("theme", "themes", { mergeStrategy: "deep" })],
      sources: [
        memory("base", 0, { "themes/dark.json": { name: "Dark" } }),
        memory("overrides", 1, { "themes/dark.json": { $patch: "theme:dark", accent: "red" } }),
      ],
    },
    [
      {
        op: "seedStore",
        args: [{ targets: { theme: "themes" }, includeProvenance: true }],
        expect: value,
      },
      { op: "readSeeded", args: ["themes", "dark"], expect: value },
    ],
  ),
  scenario(
    "store/seed-refuses-an-invalid-fixture-and-writes-nothing",
    "a missing reference makes seeding throw seed-validation-failed and write nothing (item 42)",
    {
      types: [type("theme", "themes"), type("page", "pages")],
      sources: [
        memory("pack", 0, {
          "themes/dark.json": { name: "Dark" },
          "pages/home.json": { theme: { $ref: "theme:missing" } },
        }),
      ],
    },
    [
      { op: "seedStore", args: [{ targets: { page: "pages_out" } }], expect: throws },
      { op: "readSeeded", args: ["pages_out", "home"], expect: value },
    ],
  ),
  scenario(
    "store/seed-collects-every-target-before-writing-any",
    "a later target's failure stops an earlier target's valid fixture from being written (item 43)",
    {
      types: [type("theme", "themes"), type("page", "pages")],
      sources: [
        memory("pack", 0, {
          "themes/dark.json": { name: "Dark" },
          "pages/home.json": { theme: { $ref: "theme:missing" } },
        }),
      ],
    },
    [
      {
        op: "seedStore",
        args: [{ targets: { theme: "themes_out", page: "pages_out" } }],
        expect: throws,
      },
      { op: "readSeeded", args: ["themes_out", "dark"], expect: value },
    ],
  ),
  scenario(
    "store/seed-insert-only-skips-an-existing-row",
    "insert-only reports an existing row as skipped rather than overwriting it",
    {
      types: [type("theme", "themes")],
      sources: [memory("pack", 0, { "themes/dark.json": { name: "Dark" } })],
    },
    [
      { op: "seedStore", args: [{ targets: { theme: "themes_out" } }], expect: value },
      {
        op: "seedStore",
        args: [{ targets: { theme: "themes_out" } , mode: "insert-only" }],
        expect: value,
      },
    ],
  ),
  scenario(
    "store/seed-can-skip-validation",
    "validateBeforeWrite false writes a fixture whose reference does not resolve",
    {
      types: [type("theme", "themes"), type("page", "pages")],
      sources: [
        memory("pack", 0, {
          "themes/dark.json": { name: "Dark" },
          "pages/home.json": { theme: { $ref: "theme:missing" } },
        }),
      ],
    },
    [
      {
        op: "seedStore",
        args: [{ targets: { page: "pages_out" }, validateBeforeWrite: false }],
        expect: value,
      },
      { op: "readSeeded", args: ["pages_out", "home"], expect: value },
    ],
  ),
];

/** Wrap `leaf` in `depth` levels of single-key objects. */
function nest(depth: number, leaf: unknown): unknown {
  let out = leaf;
  for (let i = 0; i < depth; i += 1) out = { child: out };
  return out;
}
