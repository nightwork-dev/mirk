import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = await import("@mirk/fixtures");
const memory = await import("@mirk/fixtures/memory");
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
assert.equal(typeof store.createStoreFixtureSource, "function", "missing store source export");
assert.equal(typeof store.seedStoreFromFixtures, "function", "missing store sink export");
assert.equal(root.createStoreFixtureSource, undefined, "root must not re-export store helpers");
assert.equal(root.createMemoryFixtureSource, undefined, "root must not re-export memory helpers");

for (const file of jsFiles("dist")) {
  const text = readFileSync(file, "utf8");
  assert.equal(/\bfrom\s+["']node:|\brequire\(["']node:/.test(text), false, `${file} imports node builtins`);
}

function jsFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return jsFiles(path);
    return entry.isFile() && entry.name.endsWith(".js") ? [path] : [];
  });
}
