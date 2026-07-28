import { createNodeEngines } from "@surrealdb/node";
import { Surreal, createRemoteEngines } from "surrealdb";

import { SurrealConnection, type SurrealConnectionOptions } from "./index.js";

export type NodeSurrealConnectionOptions = Omit<
  SurrealConnectionOptions,
  "client" | "takeOwnership"
>;

export async function createNodeSurrealConnection(
  options: NodeSurrealConnectionOptions,
): Promise<SurrealConnection> {
  const client = new Surreal({
    engines: {
      ...createRemoteEngines(),
      ...createNodeEngines(),
    },
  });
  return SurrealConnection.open({ ...options, client, takeOwnership: true });
}
