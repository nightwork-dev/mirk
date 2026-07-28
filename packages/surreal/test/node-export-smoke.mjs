import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const mode = process.argv[2];
const directory = process.argv[3];

if (mode === "write" || mode === "read") {
  const { createNodeSurrealConnection } = await import("../dist/node.js");
  const { SurrealStoreAdapter } = await import("../dist/store.js");
  const connection = await createNodeSurrealConnection({
    endpoint: `surrealkv://${directory}`,
    namespace: "mirk",
    database: "packaged_reopen",
  });
  const store = await SurrealStoreAdapter.open(connection);
  if (mode === "write") await store.set("persistent", { value: 42 });
  if (mode === "read") {
    const value = await store.get("persistent");
    if (value?.value !== 42) throw new Error(`packaged Node reopen mismatch: ${JSON.stringify(value)}`);
  }
  await connection.close();
} else {
  const databaseDirectory = await mkdtemp(join(tmpdir(), "mirk-surreal-node-smoke-"));
  const script = fileURLToPath(import.meta.url);
  try {
    runChild(script, "write", databaseDirectory);
    runChild(script, "read", databaseDirectory);
    console.log("packaged Node SurrealKV reopen: ok");
  } finally {
    await rm(databaseDirectory, { recursive: true, force: true });
  }
}

function runChild(script, childMode, databaseDirectory) {
  const result = spawnSync(process.execPath, [script, childMode, databaseDirectory], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`${childMode} subprocess failed:\n${result.stdout}\n${result.stderr}`);
  }
}
