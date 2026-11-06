import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { QdrantVectorStore, migrateLegacyQdrantVectors, pointIdFor } from "../packages/vector-qdrant/dist/index.js";

const endpoint = process.env.MIRK_QDRANT_URL;
assert.ok(endpoint, "MIRK_QDRANT_URL must name a test service");
const require = createRequire(new URL("../packages/vector-qdrant/package.json", import.meta.url));
const { QdrantClient } = require("@qdrant/js-client-rest");
const client = new QdrantClient({ url: endpoint });
const collectionName = `mirk_exchange_${randomUUID().replaceAll("-", "")}`;
const sourceCollectionName = collectionName + "_legacy";
const migrationCollectionName = collectionName + "_migrated";
const python = process.env.MIRK_QDRANT_PYTHON
  ?? fileURLToPath(new URL("../python/.venv/bin/python", import.meta.url));
const scope = "shared-\ud800";
const metadata = {
  "2": "second", "1": "first", "nested": { b: 2, a: 1 },
  "a.b": [1e-7, 1e21, null], "text": "🌱\udcff",
};

try {
  const vectors = await QdrantVectorStore.open(client, { collectionName, pageSize: 1 });
  await vectors.ensureSpace("text", { dimensions: 3 });
  await vectors.ensureSpace("image", { dimensions: 2 });
  await vectors.upsert(scope, { id: "typescript", vectors: { text: Float32Array.from([3, 4, 0]), image: Float32Array.from([0, 1]) }, metadata });
  await client.createCollection(sourceCollectionName, { vectors: { size: 3, distance: "Dot" } });
  await client.upsert(sourceCollectionName, { wait: true, points: [{
    id: pointIdFor(scope, "legacy"), vector: [3, 4, 0], payload: {
      _mirk_collection: JSON.stringify(scope), _mirk_id: JSON.stringify("legacy"),
      _mirk_vector: Buffer.from(Float32Array.from([3, 4, 0]).buffer).toString("base64"),
      _mirk_has_metadata: false, _mirk_usable: true, _mirk_terms: [],
    },
  }] });
  await assert.rejects(migrateLegacyQdrantVectors(client, {
    sourceCollectionName, collectionName: migrationCollectionName,
    onProgress: () => { throw new Error("interrupted-copy"); },
  }), /interrupted-copy/);
  const result = spawnSync(python, ["-I", "-c", `
import json, sys
from pathlib import Path
import mirk.store, mirk.vector_qdrant
from qdrant_client import QdrantClient
from mirk.vector_qdrant import QdrantVectorStore, migrateLegacyQdrantVectors

config = json.load(sys.stdin)
if config["installed"]:
    for module in (mirk.store, mirk.vector_qdrant):
        assert "site-packages" in Path(module.__file__).resolve().parts, module.__file__
client = QdrantClient(url=config["endpoint"])
try:
    vectors = QdrantVectorStore(client, collection_name=config["collection"], page_size=1)
    scope, metadata = config["scope"], config["metadata"]
    migrated = migrateLegacyQdrantVectors(client,
        source_collection_name=config["migrationSource"], collection_name=config["migrationTarget"])
    assert migrated.get(scope, "legacy") == {"id": "legacy", "vectors": {"default": [3, 4, 0]}}
    assert client.count(config["migrationSource"], exact=True).count == 1
    assert vectors.get(scope, "typescript") == {"id": "typescript", "vectors": {"text": [3, 4, 0], "image": [0, 1]}, "metadata": metadata}
    assert [row["id"] for row in vectors.search(scope, {"space": "text", "vector": [3, 4, 0]}, {"where": metadata})] == ["typescript"]
    vectors.upsert(scope, {"id": "python-🌱", "vectors": {"text": [1, 0, 0], "image": [1, 0]}, "metadata": metadata})
    vectors.upsert(scope, {"id": "typescript", "vectors": {"text": [0, 0, 2]}})
    assert vectors.count(scope) == 2
    assert vectors.count("other") == 0
    print(json.dumps({"readTypeScript": True, "wrotePython": True}))
finally:
    client.close()
`], {
    encoding: "utf8",
    input: JSON.stringify({ endpoint, collection: collectionName, migrationSource: sourceCollectionName, migrationTarget: migrationCollectionName, scope, metadata, installed: Boolean(process.env.MIRK_QDRANT_PYTHON) }),
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.deepEqual(JSON.parse(result.stdout), { readTypeScript: true, wrotePython: true });
  const migrated = await QdrantVectorStore.open(client, { collectionName: migrationCollectionName });
  assert.deepEqual(Array.from((await migrated.get(scope, "legacy")).vectors.default), [3, 4, 0]);
  const fromPython = await vectors.get(scope, "python-🌱");
  assert.deepEqual(Array.from(fromPython.vectors.text), [1, 0, 0]);
  assert.deepEqual(fromPython.metadata, metadata);
  const replaced = await vectors.get(scope, "typescript");
  assert.deepEqual(Array.from(replaced.vectors.text), [0, 0, 2]);
  assert.equal(replaced.metadata, undefined);
  assert.equal(replaced.vectors.image, undefined);
  assert.deepEqual((await vectors.search(scope, { space: "image", vector: Float32Array.from([1, 0]) })).map((row) => row.id), ["python-🌱"]);
  assert.deepEqual((await vectors.search(scope, { space: "text", vector: Float32Array.from([1, 0, 0]) }, { where: metadata })).map((row) => row.id), ["python-🌱"]);
  assert.equal(await vectors.remove(scope, "python-🌱"), true);
  assert.equal(await vectors.count(scope), 1);
  console.log(JSON.stringify({ ok: true, pythonReadTypeScript: true, typescriptReadPython: true }));
} finally {
  await client.deleteCollection(collectionName);
  for (const name of [sourceCollectionName, migrationCollectionName]) {
    if ((await client.collectionExists(name)).exists) await client.deleteCollection(name);
  }
}
