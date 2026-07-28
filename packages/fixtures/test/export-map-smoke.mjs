import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const root = await import("@mirk/fixtures");
const memory = await import("@mirk/fixtures/memory");
const filesystem = await import("@mirk/fixtures/filesystem");
const packageSource = await import("@mirk/fixtures/package");
const store = await import("@mirk/fixtures/store");

for (const key of [
  "createFixtureLoader",
  "createFixtureRegistry",
  "defineFixtureType",
  "parseRef",
  "FixtureError",
]) {
  assert.equal(typeof root[key], key === "FixtureError" ? "function" : "function", `missing root export ${key}`);
}

assert.equal(typeof memory.createMemoryFixtureSource, "function", "missing memory export");
assert.equal(typeof filesystem.createFilesystemFixtureSource, "function", "missing filesystem export");
assert.equal(typeof packageSource.createPackageFixtureSource, "function", "missing package source export");
assert.equal(typeof store.createStoreFixtureSource, "function", "missing store source export");
assert.equal(typeof store.seedStoreFromFixtures, "function", "missing store sink export");
assert.equal(root.createStoreFixtureSource, undefined, "root must not re-export store helpers");
assert.equal(root.createMemoryFixtureSource, undefined, "root must not re-export memory helpers");
assert.equal(root.createFilesystemFixtureSource, undefined, "root must not re-export filesystem helpers");
assert.equal(root.createPackageFixtureSource, undefined, "root must not re-export package helpers");

for (const file of dependencyGraph([
  "dist/index.js",
  "dist/sources/memory.js",
  "dist/sources/store.js",
])) {
  const text = readFileSync(file, "utf8");
  assert.equal(/\bfrom\s+["']node:|\brequire\(["']node:/.test(text), false, `${file} imports node builtins`);
}

function dependencyGraph(entries) {
  const pending = [...entries];
  const visited = new Set();
  while (pending.length > 0) {
    const file = pending.pop();
    if (!file || visited.has(file)) continue;
    visited.add(file);
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(/\b(?:from\s+|import\()(["'])(\.[^"']+)\1/g)) {
      const dependency = resolve(dirname(file), match[2]);
      const candidate = dependency.endsWith(".js") ? dependency : `${dependency}.js`;
      if (existsSync(candidate) && !visited.has(candidate)) pending.push(candidate);
    }
  }
  return visited;
}
