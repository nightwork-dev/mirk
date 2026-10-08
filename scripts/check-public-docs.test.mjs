import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { checkPublicDocs } from "./check-public-docs.mjs";

function fixtureRoot() {
  return mkdtempSync(join(tmpdir(), "mirk-public-docs-"));
}

test("rejects a broken link and a machine-local path", () => {
  const root = fixtureRoot();
  try {
    mkdirSync(join(root, "packages"), { recursive: true });
    writeFileSync(
      join(root, "README.md"),
      "Read [the missing guide](missing.md) from /Users/example/project.\n",
    );

    const result = checkPublicDocs(root);
    assert.match(result.failures.join("\n"), /broken relative link missing\.md/);
    assert.match(result.failures.join("\n"), /local macOS home path/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("inventories Python workspace members and requires their README", () => {
  const root = fixtureRoot();
  try {
    mkdirSync(join(root, "packages"), { recursive: true });
    mkdirSync(join(root, "python", "store"), { recursive: true });
    writeFileSync(join(root, "README.md"), "`mirk-store`\n");
    writeFileSync(
      join(root, "python", "pyproject.toml"),
      '[tool.uv.workspace]\nmembers = ["store"]\n',
    );
    writeFileSync(
      join(root, "python", "store", "pyproject.toml"),
      [
        "[project]",
        'name = "mirk-store"',
        'version = "0.1.0"',
        'description = "Storage primitives."',
        "",
      ].join("\n"),
    );

    const missing = checkPublicDocs(root);
    assert.match(missing.failures.join("\n"), /python\/store\/README\.md: missing README/);

    writeFileSync(
      join(root, "python", "store", "README.md"),
      "Read [the missing guide](missing.md) from /Users/example/project.\n",
    );
    const invalid = checkPublicDocs(root);
    assert.match(invalid.failures.join("\n"), /python\/store\/README\.md: broken relative link missing\.md/);
    assert.match(invalid.failures.join("\n"), /python\/store\/README\.md:1: local macOS home path/);

    writeFileSync(join(root, "python", "store", "README.md"), "# mirk-store\n");
    const complete = checkPublicDocs(root);
    assert.deepEqual(complete.failures, []);
    assert.deepEqual(complete.pythonDirectories, ["store"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
