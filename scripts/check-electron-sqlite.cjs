const assert = require("node:assert/strict");
const { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { pathToFileURL } = require("node:url");
const { app } = require("electron");

const root = resolve(process.env.MIRK_ROOT || join(__dirname, ".."));
const checkNames = [];
const scratchPath = mkdtempSync(join(tmpdir(), "mirk-electron-sqlite-"));
const userDataPath = join(scratchPath, "user-data");
mkdirSync(userDataPath);
app.setPath("userData", userDataPath);
app.setPath("sessionData", userDataPath);

function recordCheck(name) {
  checkNames.push(name);
}

function expectVector(actual, expected) {
  assert.ok(actual, "expected a vector document");
  assert.deepEqual(Array.from(actual.vector), expected);
}

function exerciseFacets(adapter, name) {
  const { kv, vector, search } = adapter;

  kv.set("greeting", { text: "hello" });
  assert.deepEqual(kv.get("greeting"), { text: "hello" });
  assert.equal(kv.has("greeting"), true);
  assert.deepEqual(kv.keys("greet"), ["greeting"]);
  kv.set("temporary", true);
  assert.equal(kv.delete("temporary"), true);
  assert.equal(kv.has("temporary"), false);

  kv.put("records", { id: "record-1", state: "ready", rank: 2 });
  assert.deepEqual(kv.getById("records", "record-1"), {
    id: "record-1",
    state: "ready",
    rank: 2,
  });
  assert.equal(kv.count("records"), 1);
  assert.deepEqual(kv.list("records"), [{ id: "record-1", state: "ready", rank: 2 }]);
  assert.equal(kv.remove("records", "record-1"), true);
  assert.equal(kv.getById("records", "record-1"), null);
  recordCheck(`${name}:kv`);

  vector.upsert("embeddings", {
    id: "one",
    vector: Float32Array.from([1, 0, 0]),
    metadata: { kind: "primary" },
  });
  vector.upsertMany("embeddings", [
    { id: "two", vector: Float32Array.from([0, 1, 0]), metadata: { kind: "secondary" } },
    { id: "three", vector: Float32Array.from([0.9, 0.1, 0]), metadata: { kind: "primary" } },
  ]);
  expectVector(vector.get("embeddings", "one"), [1, 0, 0]);
  assert.equal(vector.has("embeddings", "two"), true);
  assert.equal(vector.count("embeddings"), 3);
  assert.deepEqual(
    vector.search("embeddings", Float32Array.from([1, 0, 0]), { topK: 2 }).map((hit) => hit.id),
    ["one", "three"],
  );
  assert.deepEqual(
    vector.search("embeddings", Float32Array.from([1, 0, 0]), {
      topK: 3,
      where: { kind: "secondary" },
    }).map((hit) => hit.id),
    ["two"],
  );
  assert.equal(vector.remove("embeddings", "two"), true);
  assert.equal(vector.count("embeddings"), 2);
  recordCheck(`${name}:vector`);

  search.index("documents", {
    id: "doc-1",
    text: "alpha alpha river bank",
    meta: { kind: "primary" },
  });
  search.indexMany("documents", [
    { id: "doc-2", text: "beta river path", meta: { kind: "secondary" } },
    { id: "doc-3", text: "alpha mountain path", meta: { kind: "primary" } },
  ]);
  assert.deepEqual(
    search.search("documents", "alpha", { filter: { where: { kind: "primary" } } }).map((hit) => hit.id),
    ["doc-1", "doc-3"],
  );
  assert.equal(search.remove("documents", "doc-2"), true);
  assert.deepEqual(search.search("documents", "beta"), []);
  recordCheck(`${name}:search`);

  const request = {
    operations: [{ op: "set", key: `${name}:idempotent`, value: { accepted: true } }],
    idempotency: { key: `${name}:receipt`, outcome: { accepted: true } },
  };
  const first = kv.mutateAtomically(request);
  assert.equal(first.status, "applied");
  const replay = kv.mutateAtomically(request);
  assert.equal(replay.status, "replayed");
  assert.deepEqual(kv.get(`${name}:idempotent`), { accepted: true });
  const conflict = kv.mutateAtomically({
    operations: [{ op: "set", key: `${name}:idempotent`, value: { accepted: false } }],
    idempotency: { key: `${name}:receipt`, outcome: { accepted: false } },
  });
  assert.equal(conflict.status, "idempotency-conflict");
  recordCheck(`${name}:atomic-idempotency`);
}

function exerciseNestedRollback(adapter, name) {
  const { kv, vector, search } = adapter;
  kv.set(`${name}:outer`, "before");

  adapter.transaction(() => {
    kv.set(`${name}:outer`, "after");
    try {
      adapter.transaction(() => {
        kv.set(`${name}:inner`, "rolled-back");
        vector.upsert(`${name}:nested-vectors`, {
          id: "nested",
          vector: Float32Array.from([1, 0, 0]),
        });
        search.index(`${name}:nested-search`, {
          id: "nested",
          text: "rolled back",
        });
        throw new Error("nested rollback probe");
      });
    } catch (error) {
      assert.equal(error.message, "nested rollback probe");
    }
  });

  assert.equal(kv.get(`${name}:outer`), "after");
  assert.equal(kv.get(`${name}:inner`), null);
  assert.equal(vector.has(`${name}:nested-vectors`, "nested"), false);
  assert.deepEqual(search.search(`${name}:nested-search`, "rolled"), []);
  recordCheck(`${name}:nested-rollback-crossfacet`);
}

async function main() {
  assert.ok(process.versions.electron, "this harness must run in Electron");
  const scratch = scratchPath;
  const packageRoot = join(scratch, "node_modules", "@mirk");
  mkdirSync(packageRoot, { recursive: true });
  symlinkSync(join(root, "packages", "store"), join(packageRoot, "store"), "dir");
  symlinkSync(join(root, "packages", "statements"), join(packageRoot, "statements"), "dir");
  const loader = join(scratch, "load-adapters.mjs");
  writeFileSync(
    loader,
    'export { SqliteAdapter } from "@mirk/store/sqlite";\nexport { NodeSqliteAdapter } from "@mirk/store/node-sqlite";\nexport { createSqliteStatementStore } from "@mirk/statements/sqlite";\n',
  );
  const { SqliteAdapter, NodeSqliteAdapter, createSqliteStatementStore } = await import(pathToFileURL(loader));

  const adapters = [
    ["better-sqlite3", () => new SqliteAdapter({ path: join(scratch, "better-memory.sqlite"), dimensions: 3 })],
    ["node:sqlite", () => new NodeSqliteAdapter({ path: join(scratch, "node-memory.sqlite"), dimensions: 3 })],
  ];
  const results = [];

  for (const [name, open] of adapters) {
    const adapter = open();
    try {
      exerciseFacets(adapter, name);
      exerciseNestedRollback(adapter, name);
      results.push({ name, status: "passed" });
    } finally {
      adapter.close();
    }
  }

  const statements = createSqliteStatementStore({
    path: join(scratch, "statements.sqlite"),
    authority: {
      authorityId: "electron-test-authority",
      authorityRevision: "rev-1",
      decide: () => ({
        outcome: { kind: "admit", status: "accepted", reason: "electron acceptance" },
        decidedAt: 1,
      }),
    },
    now: () => new Date("2026-08-01T00:00:00.000Z"),
    receiptIdFactory: () => "electron-receipt",
  });
  const admission = {
    auth: {
      principalId: "principal:electron",
      authorityScope: "world:electron",
      callerPolicy: "electron-test",
    },
    idempotencyKey: "electron-statement",
    worldId: "electron",
    branchId: "main",
    statementId: "s1",
    recordedAt: "2026-08-01T00:00:00.000Z",
    proposition: {
      subject: { entityId: "entity-1" },
      predicate: { predicateId: "is-in" },
      object: { kind: "string", value: "electron" },
    },
    context: { kind: "world-version", worldId: "electron", branchId: "main" },
    modality: "fact",
    polarity: "positive",
    status: "accepted",
    qualifiers: {},
    provenance: {
      sources: [{ sourceId: "source:electron" }],
      origin: { source: "authored", modelInvolved: false },
    },
    derivedFrom: [],
  };
  try {
    const first = await statements.admit(admission);
    assert.equal(first.ok, true);
    const replay = await statements.admit(admission);
    assert.equal(replay.ok, true);
    assert.equal(replay.replay, true);
    const conflict = await statements.admit({ ...admission, statementId: "other" });
    assert.equal(conflict.ok, false);
    if (!conflict.ok) assert.equal(conflict.code, "idempotency-conflict");
    recordCheck("statements:better-sqlite3-13");
  } finally {
    statements.close();
  }

  const sharedPath = join(scratch, "driver-reopen.sqlite");
  const crossDriverRequest = {
    operations: [{ op: "set", key: "cross-driver-receipt", value: "node" }],
    idempotency: { key: "cross-driver-receipt", outcome: { accepted: true } },
  };
  const better = new SqliteAdapter({ path: sharedPath, dimensions: 3 });
  try {
    better.kv.set("cross-driver", { writtenBy: "better-sqlite3" });
    better.vector.upsert("cross-driver-vectors", {
      id: "better",
      vector: Float32Array.from([1, 0, 0]),
      metadata: { writer: "better-sqlite3" },
    });
    better.search.index("cross-driver-search", {
      id: "better",
      text: "cross driver persistence",
    });
  } finally {
    better.close();
  }

  const node = new NodeSqliteAdapter({ path: sharedPath, dimensions: 3 });
  try {
    assert.deepEqual(node.kv.get("cross-driver"), { writtenBy: "better-sqlite3" });
    expectVector(node.vector.get("cross-driver-vectors", "better"), [1, 0, 0]);
    assert.deepEqual(node.search.search("cross-driver-search", "persistence").map((hit) => hit.id), ["better"]);
    node.kv.set("cross-driver-node", { writtenBy: "node:sqlite" });
    node.vector.upsert("cross-driver-vectors", {
      id: "node",
      vector: Float32Array.from([0, 1, 0]),
      metadata: { writer: "node:sqlite" },
    });
    node.search.index("cross-driver-search", {
      id: "node",
      text: "node driver persistence",
    });
    assert.equal(node.kv.mutateAtomically(crossDriverRequest).status, "applied");
    recordCheck("cross-driver:better-to-node");
  } finally {
    node.close();
  }

  const reopened = new SqliteAdapter({ path: sharedPath, dimensions: 3 });
  try {
    assert.deepEqual(reopened.kv.get("cross-driver-node"), { writtenBy: "node:sqlite" });
    expectVector(reopened.vector.get("cross-driver-vectors", "node"), [0, 1, 0]);
    assert.deepEqual(reopened.search.search("cross-driver-search", "node").map((hit) => hit.id), ["node"]);
    assert.equal(reopened.kv.mutateAtomically(crossDriverRequest).status, "replayed");
    recordCheck("cross-driver:node-to-better");
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
    adapters: results,
    statements: "passed",
    crossDriverReopen: "passed",
    checks: { count: checkNames.length, names: checkNames },
  })}\n`);
}

function cleanup() {
  if (scratchPath) rmSync(scratchPath, { recursive: true, force: true });
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
