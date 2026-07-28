import { SurrealConnection } from "../dist/index.js";
import { SurrealGraphAdapter } from "../dist/graph.js";
import { SurrealObjectStore } from "../dist/storage.js";
import { SurrealStoreAdapter } from "../dist/store.js";
import { SurrealVectorAdapter } from "../dist/vector.js";

const endpoint = process.env.MIRK_SURREAL_REMOTE_URL;
if (!endpoint) throw new Error("MIRK_SURREAL_REMOTE_URL is required");

const connection = await SurrealConnection.open({
  endpoint,
  namespace: process.env.MIRK_SURREAL_NAMESPACE ?? "mirk",
  database: process.env.MIRK_SURREAL_DATABASE ?? "remote_smoke",
});

try {
  const store = await SurrealStoreAdapter.open(connection);
  await store.set("remote-proof", { value: 42 });
  if ((await store.get("remote-proof"))?.value !== 42) throw new Error("remote store mismatch");

  const vectors = await SurrealVectorAdapter.open(connection);
  await vectors.upsert("remote_docs", { id: "a", vector: new Float32Array([1, 0]) });
  if ((await vectors.search("remote_docs", new Float32Array([1, 0])))[0]?.id !== "a") {
    throw new Error("remote vector mismatch");
  }

  const graph = await SurrealGraphAdapter.open(connection, {
    graphs: { remote_edges: { nodeTable: "remote_node", relationTable: "remote_edge" } },
  });
  await graph.edges.put("remote_edges", { id: "e1", from: "a", to: "b", type: "links" });
  const traversed = await graph.edges.traverseGraph("remote_edges", { start: "a", depth: 1 });
  if (traversed.nodes[0] !== "b" || traversed.edges[0]?.id !== "e1") {
    throw new Error("remote graph mismatch");
  }

  const objects = await SurrealObjectStore.open(connection, { chunkSizeBytes: 2 });
  await objects.put("remote/object", new Uint8Array([1, 2, 3]));
  const stream = await objects.get("remote/object");
  const bytes = [];
  for await (const chunk of stream) bytes.push(...chunk);
  if (bytes.join(",") !== "1,2,3") throw new Error("remote object mismatch");

  console.log("remote ws store/vector/graph/storage: ok");
} finally {
  await connection.close();
}
