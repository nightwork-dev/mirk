import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import {
  createFixtureLoader,
  createFixtureRegistry,
  defineFixtureType,
  type StandardSchemaV1,
} from "../index.js";
import { createFilesystemFixtureSource } from "./filesystem.js";
import { createMemoryFixtureSource } from "./memory.js";
import { createPackageFixtureSource } from "./package.js";

const objectSchema: StandardSchemaV1<unknown, Record<string, unknown>> = {
  "~standard": {
    version: 1,
    vendor: "test",
    validate: (value) => typeof value === "object" && value !== null && !Array.isArray(value)
      ? { value: value as Record<string, unknown> }
      : { issues: [{ message: "Expected object." }] },
  },
};

describe("filesystem fixture source", () => {
  it("lists nested files deterministically and reads only listed entries", async () => {
    await withTemporaryDirectory(async (root) => {
      mkdirSync(join(root, "themes", "nested"), { recursive: true });
      writeFileSync(join(root, "themes", "z.json"), "{\"name\":\"z\"}");
      writeFileSync(join(root, "themes", "a.json"), "{\"name\":\"a\"}");
      writeFileSync(join(root, "themes", "nested", "ignored.json"), "{}");

      const source = createFilesystemFixtureSource({ id: "files", root });
      const entries = await source.list();

      expect(entries.map((entry) => entry.relativePath)).toEqual([
        "themes/a.json",
        "themes/nested/ignored.json",
        "themes/z.json",
      ]);
      expect(await source.read(entries[0]!)).toBe("{\"name\":\"a\"}");
      expect(() => source.read({ relativePath: "themes/a.json", locator: "entry:99" })).toThrowError(
        expect.objectContaining({ diagnostic: expect.objectContaining({ code: "source-read-failed" }) }),
      );
    });
  });

  it("rejects files whose resolved path escapes the source root", () => {
    const outside = mkdtempSync(join(tmpdir(), "mirk-fixtures-outside-"));
    try {
      withTemporaryDirectory((root) => {
        writeFileSync(join(outside, "secret.json"), "{}");
        symlinkSync(join(outside, "secret.json"), join(root, "escaped.json"));

        const source = createFilesystemFixtureSource({ id: "files", root });
        expect(() => source.list()).toThrowError(expect.objectContaining({
          diagnostic: expect.objectContaining({
            code: "source-path-escape",
            path: "escaped.json",
          }),
        }));
      });
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("does not expose an unavailable absolute root in diagnostics", () => {
    const root = join(tmpdir(), "mirk-fixtures-missing", "private");
    expect(() => createFilesystemFixtureSource({ id: "files", root })).toThrowError(
      expect.objectContaining({
        message: expect.not.stringContaining(root),
        diagnostic: expect.objectContaining({ code: "source-root-unavailable" }),
      }),
    );
  });
});

describe("package fixture source", () => {
  it("loads a file-backed package resource through the ordinary fixture loader", async () => {
    await withTemporaryDirectory(async (root) => {
      mkdirSync(join(root, "themes"), { recursive: true });
      writeFileSync(join(root, "themes", "dark.json"), "{\"name\":\"dark\"}");

      const registry = createFixtureRegistry();
      registry.register(defineFixtureType({
        type: "theme",
        directory: "themes",
        schema: objectSchema,
      }));
      const source = createPackageFixtureSource({
        id: "defaults",
        rootUrl: pathToFileURL(`${root}/`),
      });
      const loader = createFixtureLoader({ registry, sources: [source] });

      await expect(loader.load("theme:dark")).resolves.toEqual({ name: "dark" });
    });
  });

  it("fails closed for non-file package URLs", () => {
    expect(() => createPackageFixtureSource({
      id: "defaults",
      rootUrl: new URL("https://example.com/fixtures/"),
    })).toThrowError(expect.objectContaining({
      diagnostic: expect.objectContaining({ code: "unsupported-package-source" }),
    }));
  });
});

function withTemporaryDirectory<T>(work: (root: string) => T): T {
  const root = mkdtempSync(join(tmpdir(), "mirk-fixtures-"));
  try {
    const result = work(root);
    if (result instanceof Promise) {
      return result.finally(() => rmSync(root, { recursive: true, force: true })) as T;
    }
    rmSync(root, { recursive: true, force: true });
    return result;
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

describe("filesystem source ordering", () => {
  // The comparator used to be `localeCompare`, which is ICU collation: it puts
  // "a" before "Z" and depends on the runtime's ICU build. The memory source
  // has always ordered by code point, so the two sources disagreed on the same
  // set of paths. All of them now use `compareCodePoints`, and this is the case
  // that tells the two comparators apart.
  it("lists entries in code point order, not collation order", async () => {
    await withTemporaryDirectory(async (root) => {
      mkdirSync(join(root, "themes"), { recursive: true });
      // Case-insensitive filesystems fold "b.json" into "B.json", so the case
      // pair that tells the comparators apart is a lowercase letter against an
      // uppercase one that sorts after it by code point.
      for (const name of ["a.json", "Z.json", "B.json"]) {
        writeFileSync(join(root, "themes", name), "{}");
      }

      const source = createFilesystemFixtureSource({ id: "files", root });
      const entries = await source.list();

      expect(entries.map((entry) => entry.relativePath)).toEqual([
        "themes/B.json",
        "themes/Z.json",
        "themes/a.json",
      ]);
    });
  });

  it("agrees with the memory source on the same set of paths", async () => {
    await withTemporaryDirectory(async (root) => {
      mkdirSync(join(root, "themes"), { recursive: true });
      const names = ["a.json", "Z.json", "B.json", "ä.json", "\u{1f600}.json"];
      for (const name of names) writeFileSync(join(root, "themes", name), "{}");

      const files = await createFilesystemFixtureSource({ id: "files", root }).list();
      const memoryFiles: Record<string, string> = {};
      for (const name of names) memoryFiles[`themes/${name}`] = "{}";
      const inMemory = await createMemoryFixtureSource({ id: "memory", files: memoryFiles }).list();

      expect(files.map((entry) => entry.relativePath)).toEqual(
        inMemory.map((entry) => entry.relativePath),
      );
    });
  });
});
