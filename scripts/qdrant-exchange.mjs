import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { QdrantVectorStore } from "../packages/vector-qdrant/dist/index.js";

const endpoint = process.env.MIRK_QDRANT_URL;
assert.ok(endpoint, "MIRK_QDRANT_URL must name a test service");
const require = createRequire(new URL("../packages/vector-qdrant/package.json", import.meta.url));
const { QdrantClient } = require("@qdrant/js-client-rest");
const client = new QdrantClient({ url: endpoint });
const collectionName = `mirk_exchange_${randomUUID().replaceAll("-", "")}`;
const python = process.env.MIRK_QDRANT_PYTHON
  ?? fileURLToPath(new URL("../python/.venv/bin/python", import.meta.url));
const scope = "shared-\ud800";
const metadata = {
  "2": "second", "1": "first", "nested": { b: 2, a: 1 },
  "a.b": [1e-7, 1e21, null], "text": "🌱\udcff",
};

try {
  const vectors = await QdrantVectorStore.open(client, { collectionName, dimensions: 3, pageSize: 1 });
  await vectors.upsert(scope, { id: "typescript", vector: Float32Array.from([3, 4, 0]), metadata });
  const result = spawnSync(python, ["-I", "-c", `
import json, sys
from pathlib import Path
import mirk.store, mirk.vector_qdrant
from qdrant_client import QdrantClient
from mirk.vector_qdrant import QdrantVectorStore

config = json.load(sys.stdin)
if config["installed"]:
    for module in (mirk.store, mirk.vector_qdrant):
        assert "site-packages" in Path(module.__file__).resolve().parts, module.__file__
client = QdrantClient(url=config["endpoint"])
try:
    vectors = QdrantVectorStore(client, collection_name=config["collection"], dimensions=3, page_size=1)
    scope, metadata = config["scope"], config["metadata"]
    assert vectors.get(scope, "typescript") == {"id": "typescript", "vector": [3, 4, 0], "metadata": metadata}
    assert [row["id"] for row in vectors.search(scope, [3, 4, 0], {"where": metadata})] == ["typescript"]
    vectors.upsert(scope, {"id": "python-🌱", "vector": [1, 0, 0], "metadata": metadata})
    vectors.upsert(scope, {"id": "typescript", "vector": [0, 0, 2]})
    assert vectors.count(scope) == 2
    assert vectors.count("other") == 0
    print(json.dumps({"readTypeScript": True, "wrotePython": True}))
finally:
    client.close()
`], {
    encoding: "utf8",
    input: JSON.stringify({ endpoint, collection: collectionName, scope, metadata, installed: Boolean(process.env.MIRK_QDRANT_PYTHON) }),
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.deepEqual(JSON.parse(result.stdout), { readTypeScript: true, wrotePython: true });
  const fromPython = await vectors.get(scope, "python-🌱");
  assert.deepEqual(Array.from(fromPython.vector), [1, 0, 0]);
  assert.deepEqual(fromPython.metadata, metadata);
  const replaced = await vectors.get(scope, "typescript");
  assert.deepEqual(Array.from(replaced.vector), [0, 0, 2]);
  assert.equal(replaced.metadata, undefined);
  assert.deepEqual((await vectors.search(scope, Float32Array.from([1, 0, 0]), { where: metadata })).map((row) => row.id), ["python-🌱"]);
  assert.equal(await vectors.remove(scope, "python-🌱"), true);
  assert.equal(await vectors.count(scope), 1);
  console.log(JSON.stringify({ ok: true, pythonReadTypeScript: true, typescriptReadPython: true }));
} finally {
  await client.deleteCollection(collectionName);
}
