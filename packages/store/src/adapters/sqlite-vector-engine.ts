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
  initialize(db: SqliteDb): void;
  search(db: SqliteDb, request: SqliteVectorSearchRequest): VectorSearchResult[];
}
