import { expect, test } from "vitest";
import { SurrealWasmEngine } from "@surrealdb/wasm-native";

import { SurrealStoreAdapter } from "./store.js";
import { createWasmSurrealConnection } from "./wasm.js";

test("runs the Mirk store adapter over the WASM memory engine", async () => {
  const connection = await withDeadline("memory connection", createWasmSurrealConnection({
    namespace: "mirk",
    database: "browser",
  }));
  expect(SurrealWasmEngine.version()).toBe("3.3.4");
  const store = await withDeadline("store adapter", SurrealStoreAdapter.open(connection));
  await withDeadline("store write", store.set("browser", { engine: "wasm" }));
  await expect(withDeadline("store read", store.get("browser"))).resolves.toEqual({
    engine: "wasm",
  });
  await withDeadline("memory close", connection.close());
}, 30_000);

test("runs the Mirk store adapter over the WASM IndexedDB engine", async () => {
  const endpoint = `indxdb://mirk_${Date.now()}`;
  const connection = await withDeadline("indexeddb connection", createWasmSurrealConnection({
    endpoint,
    namespace: "mirk",
    database: "browser",
  }));
  const store = await withDeadline("indexeddb store adapter", SurrealStoreAdapter.open(connection));
  await withDeadline("indexeddb store write", store.set("browser", { engine: "wasm-indxdb" }));
  await expect(withDeadline("indexeddb store read", store.get("browser"))).resolves.toEqual({
    engine: "wasm-indxdb",
  });
  await withDeadline("indexeddb close", connection.close());
}, 30_000);

async function withDeadline<T>(label: string, promise: Promise<T>): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      globalThis.setTimeout(() => reject(new Error(`${label} timed out`)), 15_000);
    }),
  ]);
}
