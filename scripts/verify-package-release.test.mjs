import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const script = fileURLToPath(new URL("./verify-package-release.mjs", import.meta.url));
const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")));

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "mirk-release-boundary-")));
  const scripts = join(root, "scripts");
  const packageRoot = join(root, "packages/store-libsql");
  const dist = join(packageRoot, "dist");
  mkdirSync(scripts, { recursive: true });
  mkdirSync(dist, { recursive: true });
  cpSync(script, join(scripts, "verify-package-release.mjs"));
  const project = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "release-boundary-fixture", private: true,
    type: "module", packageManager: project.packageManager }));
  writeFileSync(join(root, "pnpm-workspace.yaml"), 'packages:\n  - "packages/*"\n');
  writeFileSync(join(packageRoot, "package.json"), JSON.stringify({
    name: "@mirk/store-libsql", version: "0.0.0", type: "module", license: "Apache-2.0", files: ["dist"],
    main: "./dist/index.js", types: "./dist/index.d.ts",
    exports: {
      ".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
      "./remote": { types: "./dist/remote.d.ts", import: "./dist/remote.js" },
    },
  }));
  writeFileSync(join(dist, "index.js"), 'export { createClient } from "@libsql/client";\n');
  writeFileSync(join(dist, "index.d.ts"), 'export declare const createClient: unknown;\n');
  writeFileSync(join(dist, "remote.d.ts"), 'export declare const createClient: unknown;\n');
  execFileSync("git", ["init", "--quiet"], { cwd: root, env: environment });
  execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "user.name=Release test",
    "-c", "user.email=release-test@example.com", "commit", "--allow-empty", "--no-gpg-sign", "--quiet", "-m", "fixture"],
    { cwd: root, env: environment });
  return { root, dist };
}

function verify(root) {
  return spawnSync(process.execPath, [join(root, "scripts/verify-package-release.mjs"),
    "--package", "@mirk/store-libsql", "--skip-build", "--skip-test", "--skip-typecheck",
    "--skip-conformance", "--skip-install", "--out", join(root, "receipt.json")],
  { cwd: root, env: environment, encoding: "utf8", timeout: 30_000 });
}

test("checks the packed remote export while allowing the native-capable root", () => {
  const { root, dist } = fixture();
  try {
    writeFileSync(join(dist, "remote.js"), 'export { createClient } from "@libsql/client/web";\n');
    const result = verify(root);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const receipt = JSON.parse(readFileSync(join(root, "receipt.json"), "utf8"));
    assert.equal(receipt.checks.find((check) => check.name === "remote-dependency-boundary")?.status, "passed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects a native import reached through a packed remote chunk", () => {
  const { root, dist } = fixture();
  try {
    writeFileSync(join(dist, "remote.js"), 'import "./shared.js";\nexport { createClient } from "@libsql/client/web";\n');
    writeFileSync(join(dist, "shared.js"), 'import "@libsql/client";\n');
    const result = verify(root);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /remote export reaches native driver @libsql\/client/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects a packed remote entry that omits the web client", () => {
  const { root, dist } = fixture();
  try {
    writeFileSync(join(dist, "remote.js"), 'export const createClient = undefined;\n');
    const result = verify(root);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /remote export does not use the web client/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects a package that omits its configured remote export", () => {
  const { root } = fixture();
  try {
    const manifestPath = join(root, "packages/store-libsql/package.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    delete manifest.exports["./remote"];
    writeFileSync(manifestPath, JSON.stringify(manifest));
    const result = verify(root);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /remote export is missing/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
