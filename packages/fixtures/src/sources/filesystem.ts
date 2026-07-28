import { readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { FixtureError } from "../errors.js";
import type { FixtureSource, FixtureSourceEntry } from "../types.js";

export interface FilesystemFixtureSourceOptions {
  id: string;
  root: string | URL;
}

interface ListedFile {
  relativePath: string;
  realPath: string;
}

export function createFilesystemFixtureSource(opts: FilesystemFixtureSourceOptions): FixtureSource {
  const root = resolveRoot(opts);
  let listed = new Map<string, ListedFile>();

  return {
    id: opts.id,
    list(): FixtureSourceEntry[] {
      const files = walk(root, opts.id);
      listed = new Map(files.map((file, index) => [`entry:${index}`, file]));
      return [...listed].map(([locator, file]) => ({
        relativePath: file.relativePath,
        locator,
      }));
    },
    read(entry: FixtureSourceEntry): string {
      const file = listed.get(entry.locator);
      if (!file || file.relativePath !== entry.relativePath) {
        throw sourceError(opts.id, entry.relativePath, "has no listed entry");
      }

      const currentRealPath = resolveListedFile(root, file.relativePath, opts.id);
      if (currentRealPath !== file.realPath) {
        throw sourceError(opts.id, file.relativePath, "entry changed after it was listed");
      }

      try {
        return readFileSync(currentRealPath, "utf8");
      } catch {
        throw sourceError(opts.id, file.relativePath, "could not read entry");
      }
    },
  };
}

function resolveRoot(opts: FilesystemFixtureSourceOptions): string {
  const unresolved = opts.root instanceof URL ? fileUrlPath(opts.root, opts.id) : opts.root;
  try {
    const root = realpathSync(resolve(unresolved));
    if (!statSync(root).isDirectory()) {
      throw new Error("not a directory");
    }
    return root;
  } catch {
    throw new FixtureError({
      severity: "error",
      code: "source-root-unavailable",
      message: `Filesystem source "${opts.id}" root is unavailable or is not a directory.`,
      source: opts.id,
    });
  }
}

function fileUrlPath(url: URL, sourceId: string): string {
  if (url.protocol !== "file:") {
    throw new FixtureError({
      severity: "error",
      code: "unsupported-source-url",
      message: `Filesystem source "${sourceId}" requires a file: URL.`,
      source: sourceId,
    });
  }
  return fileURLToPath(url);
}

function walk(root: string, sourceId: string): ListedFile[] {
  const files: ListedFile[] = [];

  const visit = (directory: string, prefix: string): void => {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true })
        .sort((left, right) => left.name.localeCompare(right.name));
    } catch {
      throw sourceError(sourceId, prefix || ".", "could not list directory");
    }

    for (const entry of entries) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      assertRelativePath(relativePath, sourceId);
      const discoveredPath = resolve(directory, entry.name);
      let realPath: string;
      let kind;
      try {
        realPath = realpathSync(discoveredPath);
        assertInsideRoot(root, realPath, sourceId, relativePath);
        kind = statSync(realPath);
      } catch (error) {
        if (error instanceof FixtureError) throw error;
        throw sourceError(sourceId, relativePath, "could not resolve entry");
      }

      if (kind.isDirectory()) {
        if (!entry.isSymbolicLink()) visit(realPath, relativePath);
        continue;
      }
      if (kind.isFile()) files.push({ relativePath, realPath });
    }
  };

  visit(root, "");
  return files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

function resolveListedFile(root: string, relativePath: string, sourceId: string): string {
  assertRelativePath(relativePath, sourceId);
  try {
    const realPath = realpathSync(resolve(root, ...relativePath.split("/")));
    assertInsideRoot(root, realPath, sourceId, relativePath);
    if (!statSync(realPath).isFile()) throw new Error("not a file");
    return realPath;
  } catch (error) {
    if (error instanceof FixtureError) throw error;
    throw sourceError(sourceId, relativePath, "could not resolve entry");
  }
}

function assertInsideRoot(root: string, candidate: string, sourceId: string, relativePath: string): void {
  const fromRoot = relative(root, candidate);
  if (fromRoot === ".." || fromRoot.startsWith("../") || isAbsolute(fromRoot)) {
    throw new FixtureError({
      severity: "error",
      code: "source-path-escape",
      message: `Filesystem source "${sourceId}" entry "${relativePath}" resolves outside its root.`,
      source: sourceId,
      path: relativePath,
    });
  }
}

function assertRelativePath(path: string, sourceId: string): void {
  const parts = path.split("/");
  if (
    path === ""
    || path.includes("\\")
    || path.startsWith("/")
    || /^[A-Za-z]:/.test(path)
    || parts.some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new FixtureError({
      severity: "error",
      code: "unsafe-relative-path",
      message: `Filesystem source "${sourceId}" entry "${path}" is not a safe source-relative path.`,
      source: sourceId,
      path,
    });
  }
}

function sourceError(sourceId: string, path: string, action: string): FixtureError {
  return new FixtureError({
    severity: "error",
    code: "source-read-failed",
    message: `Filesystem source "${sourceId}" ${action} "${path}".`,
    source: sourceId,
    path,
  });
}
