import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MarkdownStore, MarkdownStoreCorruptionError } from "../src/index.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mirk-markdown-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("MarkdownStore contract", () => {
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
    expect(() => store.put("stories", {
      ...story("todo"),
      id: "DOC-102",
    })).toThrow(/filename collision/i);
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
