const assert = require("node:assert/strict");
const { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { pathToFileURL } = require("node:url");
const { app } = require("electron");

const root = resolve(process.env.MIRK_ROOT || join(__dirname, ".."));
const scratchPath = mkdtempSync(join(tmpdir(), "mirk-electron-sqlite-"));
const userDataPath = join(scratchPath, "user-data");
mkdirSync(userDataPath);
app.setPath("userData", userDataPath);
app.setPath("sessionData", userDataPath);

function exerciseNestedRollback(adapter, name) {
  adapter.transaction(() => {
    adapter.kv.set(`${name}:outer`, "kept");
    try {
      adapter.transaction(() => {
        adapter.kv.set(`${name}:inner`, "rolled-back");
        throw new Error("nested rollback probe");
      });
    } catch (error) {
      assert.equal(error.message, "nested rollback probe");
    }
  });
  assert.equal(adapter.kv.get(`${name}:outer`), "kept");
  assert.equal(adapter.kv.get(`${name}:inner`), null);
}

async function main() {
  assert.ok(process.versions.electron, "this harness must run in Electron");
  const packageRoot = join(scratchPath, "node_modules", "@mirk");
  mkdirSync(packageRoot, { recursive: true });
  symlinkSync(join(root, "packages", "store"), join(packageRoot, "store"), "dir");
  const loader = join(scratchPath, "load-adapters.mjs");
  writeFileSync(
    loader,
    'export { SqliteAdapter } from "@mirk/store/sqlite";\nexport { NodeSqliteAdapter } from "@mirk/store/node-sqlite";\n',
  );
  const { SqliteAdapter, NodeSqliteAdapter } = await import(pathToFileURL(loader));
  const databasePath = join(scratchPath, "driver-reopen.sqlite");

  const better = new SqliteAdapter({ path: databasePath, dimensions: 3 });
  try {
    better.kv.set("better", { writtenBy: "better-sqlite3" });
    better.vector.upsert("vectors", { id: "better", vector: Float32Array.from([1, 0, 0]) });
    better.search.index("pages", { id: "better", text: "better driver persistence" });
    exerciseNestedRollback(better, "better");
  } finally {
    better.close();
  }

  const node = new NodeSqliteAdapter({ path: databasePath, dimensions: 3 });
  try {
    assert.deepEqual(node.kv.get("better"), { writtenBy: "better-sqlite3" });
    assert.deepEqual(Array.from(node.vector.get("vectors", "better").vector), [1, 0, 0]);
    assert.equal(node.search.search("pages", "persistence")[0]?.id, "better");

    node.kv.set("node", { writtenBy: "node:sqlite" });
    node.vector.upsert("vectors", { id: "node", vector: Float32Array.from([0, 1, 0]) });
    node.search.index("pages", { id: "node", text: "node driver persistence" });
    exerciseNestedRollback(node, "node");
  } finally {
    node.close();
  }

  const reopened = new SqliteAdapter({ path: databasePath, dimensions: 3 });
  try {
    assert.deepEqual(reopened.kv.get("node"), { writtenBy: "node:sqlite" });
    assert.deepEqual(Array.from(reopened.vector.get("vectors", "node").vector), [0, 1, 0]);
    assert.equal(reopened.search.search("pages", "node")[0]?.id, "node");
  } finally {
    reopened.close();
  }

  process.stdout.write(`${JSON.stringify({
    runtime: {
      electron: process.versions.electron,
      node: process.versions.node,
      napi: process.versions.napi,
      platform: process.platform,
      arch: process.arch,
    },
    adapters: ["better-sqlite3", "node:sqlite"],
    crossDriverReopen: "passed",
    nestedRollback: "passed",
  })}\n`);
}

function cleanup() {
  rmSync(scratchPath, { recursive: true, force: true });
}

app.whenReady().then(main).then(
  () => {
    cleanup();
    app.exit(0);
  },
  (error) => {
    cleanup();
    process.stderr.write(`${error && error.stack ? error.stack : String(error)}\n`);
    app.exit(1);
  },
);
