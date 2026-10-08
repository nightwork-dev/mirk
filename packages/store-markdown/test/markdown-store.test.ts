import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MarkdownStore, MarkdownStoreCorruptionError, MarkdownStoreError } from "../src/index.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mirk-markdown-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("MarkdownStore contract", () => {
  it("sorts string fields by code point", () => {
    const store = new MarkdownStore({ rootDir: root });
    store.put("documents", { id: "a", label: "🌱" });
    store.put("documents", { id: "b", label: "�" });
    expect(store.list<{ id: string }>("documents", { sortBy: "label" }).map((row) => row.id)).toEqual(["b", "a"]);
    expect(store.list<{ id: string }>("documents", { sortBy: "label", sortDir: "desc" }).map((row) => row.id)).toEqual(["a", "b"]);
  });
  it("implements key-value, collection, filtering, sorting, and pagination semantics", () => {
    const store = new MarkdownStore({ rootDir: root });
    store.set("settings/theme", { mode: "dark" });
    expect(store.get("settings/theme")).toEqual({ mode: "dark" });
    expect(store.has("settings/theme")).toBe(true);
    expect(store.keys("settings/")).toEqual(["settings/theme"]);

    store.put("projects", { id: "p1", group: "a", rank: 3 });
    store.put("projects", { id: "p2", group: "a", rank: 1 });
    store.put("projects", { id: "p3", group: "b", rank: 2 });
    expect(store.getById("projects", "p2")).toEqual({ id: "p2", group: "a", rank: 1 });
    expect(store.list<{ id: string }>("projects", {
      where: { group: "a" },
      sortBy: "rank",
      offset: 1,
      limit: 1,
    }).map((item) => item.id)).toEqual(["p1"]);
    expect(store.count("projects", { where: { group: "a" } })).toBe(2);
    expect(store.remove("projects", "p3")).toBe(true);
    expect(store.remove("projects", "p3")).toBe(false);
    expect(store.delete("settings/theme")).toBe(true);
    expect(store.get("settings/theme")).toBeNull();
  });

  it("orders keys and records by code point, not locale collation or UTF-16 code unit", () => {
    const store = new MarkdownStore({ rootDir: root });
    const ids = ["a", "B", "_", "é", "Z", "\u{1F600}", "\uFFFD"];
    const expected = ["B", "Z", "_", "a", "é", "\uFFFD", "\u{1F600}"];
    for (const id of ids) {
      store.set(id, id);
      store.put("things", { id });
    }
    expect(store.keys()).toEqual(expected);
    expect(store.list<{ id: string }>("things").map((item) => item.id)).toEqual(expected);
  });

  it("matches YAML 1.2 scalar behavior and rejects empty keys", () => {
    const store = new MarkdownStore({ rootDir: root });
    mkdirSync(join(root, "things"), { recursive: true });
    writeFileSync(join(root, "things", "one.md"), "---\nid: one\ndate: 2024-01-02\ncount: 1_000\ntruth: true\n---\n");
    expect(store.getById("things", "one")).toMatchObject({ date: "2024-01-02", count: "1_000", truth: true });
    writeFileSync(join(root, "things", "one.md"), "---\r\nid: one\r\n---\r\n");
    expect(() => store.getById("things", "one")).toThrow(expect.objectContaining({ code: "missing-frontmatter-open" }));
    expect(() => store.set("", "invalid")).toThrow(expect.objectContaining({ code: "invalid-record-id" }));
  });
});

describe("roadmap-shaped human round-trip", () => {
  it("preserves manual edits, unknown headmatter and body sections, sticky filenames, and regenerates the index", () => {
    const store = roadmapStore(false);
    store.put("stories", {
      id: "DOC-101",
      title: "Markdown Store",
      status: "todo",
      intent: "Canonical persistence.",
      acceptanceCriteria: ["Files remain editable", "Index stays derived"],
    });

    const path = join(root, "stories", "markdown-store.md");
    const created = readFileSync(path, "utf8");
    expect(created).toContain("## Acceptance criteria");
    expect(readFileSync(join(root, "stories", "INDEX.md"), "utf8")).toContain("DOC-101 · Markdown Store · todo");

    writeFileSync(path, created
      .replace("status: todo", "status: in-progress\nexternalOwner: reviewer")
      .replace("Canonical persistence.", "Edited by hand.")
      .concat("\n## Operator notes\n\nKeep this exact prose.\n"));

    expect(store.getById<Story>("stories", "DOC-101")).toMatchObject({
      status: "in-progress",
      intent: "Edited by hand.",
      externalOwner: "reviewer",
    });

    store.put("stories", {
      id: "DOC-101",
      title: "Renamed title",
      status: "done",
      intent: "Edited by hand.",
      acceptanceCriteria: ["Still lossless"],
    });

    const updated = readFileSync(path, "utf8");
    expect(updated).toContain("externalOwner: reviewer");
    expect(updated).toContain("## Operator notes\n\nKeep this exact prose.");
    expect(updated).toContain("- [ ] Still lossless");
    expect(readFileSync(join(root, "stories", "INDEX.md"), "utf8")).toContain("DOC-101 · Renamed title · done");
  });

  it("creates one git commit per successful mutation and history reconstructs the previous file", () => {
    const store = roadmapStore(true);
    store.put("stories", story("todo"));
    store.put("stories", story("done"));

    const count = execFileSync("git", ["-C", root, "rev-list", "--count", "HEAD"], { encoding: "utf8" }).trim();
    expect(count).toBe("2");
    const previous = execFileSync("git", ["-C", root, "show", "HEAD~1:stories/markdown-store.md"], { encoding: "utf8" });
    expect(previous).toContain("status: todo");
    expect(previous).not.toContain("status: done");
  });

  it("validates and reserves a custom index filename before record writes", () => {
    const escaped = new MarkdownStore({ rootDir: join(root, "escaped"), collections: { things: { index: { fileName: "../outside.md", renderLine: () => "" } } } });
    expect(() => escaped.put("things", { id: "one" })).toThrow(expect.objectContaining({ code: "unsafe-filename" }));
    expect(existsSync(join(root, "escaped", "things"))).toBe(false);
  });

  it("reserves Unicode and case-fold filename aliases", () => {
    for (const [recordName, indexName] of [["catalog", "Catalog"], ["ss", "ß"], ["é", "e\u0301"]] as const) {
      const indexed = new MarkdownStore({ rootDir: join(root, `index-${recordName}`), collections: { things: {
        fileName: () => `${recordName}.md`,
        index: { fileName: `${indexName}.md`, renderLine: () => "" },
      } } });
      expect(() => indexed.put("things", { id: "first" })).toThrow(expect.objectContaining({ code: "unsafe-filename" }));
    }
    const store = new MarkdownStore({ rootDir: join(root, "aliases"), collections: { things: { fileName: (item) => `${String(item.name)}.md` } } });
    for (const [first, second] of [["Catalog", "catalog"], ["ß", "ss"], ["e\u0301", "é"]] as const) {
      store.put("things", { id: first, name: first });
      expect(() => store.put("things", { id: second, name: second })).toThrow(expect.objectContaining({ code: "filename-collision" }));
    }
    const kv = new MarkdownStore({ rootDir: join(root, "kv-aliases") });
    kv.set("Catalog", "first");
    expect(() => kv.set("catalog", "second")).toThrow(expect.objectContaining({ code: "filename-collision" }));
  });

  it("does not let a record claim the configured index filename", () => {
    const store = new MarkdownStore({ rootDir: join(root, "reserved"), collections: { things: { index: { fileName: "catalog.md", renderLine: () => "" } } } });
    expect(() => store.put("things", { id: "catalog" })).toThrow(expect.objectContaining({ code: "unsafe-filename" }));
    store.put("things", { id: "one" });
    const before = readFileSync(join(root, "reserved", "things", "catalog.md"), "utf8");
    expect(() => store.put("things", { id: "catalog" })).toThrow(expect.objectContaining({ code: "unsafe-filename" }));
    expect(readFileSync(join(root, "reserved", "things", "catalog.md"), "utf8")).toBe(before);
  });

  it("does not overwrite an existing record when an index is later configured at its filename", () => {
    new MarkdownStore({ rootDir: join(root, "existing") }).put("things", { id: "catalog", value: "original" });
    const path = join(root, "existing", "things", "catalog.md");
    const before = readFileSync(path, "utf8");
    const reopened = new MarkdownStore({ rootDir: join(root, "existing"), collections: { things: { index: { fileName: "catalog.md", renderLine: () => "" } } } });
    expect(() => reopened.put("things", { id: "new", value: "replacement" })).toThrow(expect.objectContaining({ code: "filename-collision" }));
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(reopened.getById("things", "new")).toBeNull();
  });

  it("stages and commits only the mutation paths", () => {
    execFileSync("git", ["-C", root, "init"], { stdio: "ignore" });
    writeFileSync(join(root, "unrelated.txt"), "keep staged");
    execFileSync("git", ["-C", root, "add", "--", "unrelated.txt"], { stdio: "ignore" });
    const store = new MarkdownStore({ rootDir: root, git: true });
    store.set("key", "value");
    expect(execFileSync("git", ["-C", root, "status", "--short"], { encoding: "utf8" })).toContain("A  unrelated.txt");
    const committed = execFileSync("git", ["-C", root, "show", "--name-only", "--format=", "HEAD"], { encoding: "utf8" });
    expect(committed).toContain(".mirk-kv/key.md");
    expect(committed).not.toContain("unrelated.txt");
  });

  it("reports every corrupt record by path instead of silently returning partial data", () => {
    const store = roadmapStore(false);
    store.put("stories", story("todo"));
    writeFileSync(join(root, "stories", "broken.md"), "not frontmatter\n");
    writeFileSync(join(root, "stories", "also-broken.md"), "---\nid: [\n---\n");

    try {
      store.list("stories");
      throw new Error("expected corruption error");
    } catch (error) {
      expect(error).toBeInstanceOf(MarkdownStoreCorruptionError);
      const corruption = error as MarkdownStoreCorruptionError;
      expect(corruption.errors).toHaveLength(2);
      expect(corruption.message).toContain("broken.md");
      expect(corruption.message).toContain("also-broken.md");
    }
  });

  it("rejects a custom filename collision instead of overwriting another record", () => {
    const store = roadmapStore(false);
    store.put("stories", story("todo"));
    const collide = () => store.put("stories", {
      ...story("todo"),
      id: "DOC-102",
    });
    expect(collide).toThrow(MarkdownStoreError);
    expect(collide).toThrow(expect.objectContaining({ code: "filename-collision" }));
    expect(store.getById<Story>("stories", "DOC-101")?.id).toBe("DOC-101");
  });
});

interface Story extends Record<string, unknown> {
  id: string;
  title: string;
  status: string;
  intent: string;
  acceptanceCriteria: string[];
  externalOwner?: string;
}

function story(status: string): Story {
  return {
    id: "DOC-101",
    title: "Markdown Store",
    status,
    intent: "Canonical persistence.",
    acceptanceCriteria: ["Files remain editable"],
  };
}

function roadmapStore(git: boolean): MarkdownStore {
  return new MarkdownStore({
    rootDir: root,
    git,
    collections: {
      stories: {
        directory: "stories",
        frontmatterFields: ["title", "status"],
        fileName: (item) => `${String(item.title).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}.md`,
        body: {
          preambleField: "intent",
          sections: {
            acceptanceCriteria: {
              heading: "Acceptance criteria",
              parse: (markdown) => markdown.split("\n").map((line) => /^- \[[ xX]\] (.*)$/.exec(line)?.[1]).filter((value): value is string => value !== undefined),
              stringify: (value) => (value as string[]).map((criterion) => `- [ ] ${criterion}`).join("\n"),
            },
          },
        },
        index: {
          heading: "Roadmap",
          renderLine: (item) => `- ${item.id} · ${item.title} · ${item.status}`,
        },
      },
    },
  });
}
