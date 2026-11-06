import type { VectorSearchOptions, VectorSearchResult } from "../vector/types.js";
import type { SqliteDb } from "./sqlite-driver.js";

export interface SqliteVectorSearchRequest {
  namespace: string;
  collection: string;
  space: string;
  vector: Float32Array;
  options?: VectorSearchOptions;
}

export interface SqliteVectorEngine {
  readonly name: string;
  /** Return false to select the existing ordinary exact engine on this connection. */
  initialize(db: SqliteDb): void | false;
  search(db: SqliteDb, request: SqliteVectorSearchRequest): VectorSearchResult[];
}
