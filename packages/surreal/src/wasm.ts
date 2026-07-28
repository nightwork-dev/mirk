import { createWasmEngines } from "@surrealdb/wasm";
import { Surreal, createRemoteEngines } from "surrealdb";

import { SurrealConnection, type SurrealConnectionOptions } from "./index.js";

export type WasmEngineOptions = Parameters<typeof createWasmEngines>[0];

export type WasmSurrealConnectionOptions = Omit<
  SurrealConnectionOptions,
  "client" | "takeOwnership"
> & {
  engineOptions?: WasmEngineOptions;
};

export async function createWasmSurrealConnection(
  options: WasmSurrealConnectionOptions = {},
): Promise<SurrealConnection> {
  const { engineOptions, endpoint = "mem://", ...connectionOptions } = options;
  const client = new Surreal({
    engines: {
      ...createRemoteEngines(),
      ...createWasmEngines(engineOptions),
    },
  });
  return SurrealConnection.open({
    ...connectionOptions,
    endpoint,
    client,
    takeOwnership: true,
  });
}
