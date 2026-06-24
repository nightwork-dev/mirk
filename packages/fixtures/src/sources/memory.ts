import { FixtureError } from "../errors.js";
import type { FixtureSource, FixtureSourceEntry } from "../types.js";

export interface MemoryFixtureSourceOptions {
  id: string;
  files: Record<string, string>;
}

export function createMemoryFixtureSource(opts: MemoryFixtureSourceOptions): FixtureSource {
  const files = new Map(Object.entries(opts.files).map(([path, content]) => [normalizePath(path), content]));

  return {
    id: opts.id,
    list(): FixtureSourceEntry[] {
      return [...files.keys()].sort().map((relativePath) => ({ relativePath, locator: relativePath }));
    },
    read(entry: FixtureSourceEntry): string {
      const content = files.get(entry.locator);
      if (content === undefined) {
        throw new FixtureError({
          severity: "error",
          code: "source-read-failed",
          message: `Memory source "${opts.id}" has no entry "${entry.relativePath}".`,
          source: opts.id,
          path: entry.relativePath,
        });
      }
      return content;
    },
  };
}

function normalizePath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//, "");
}
