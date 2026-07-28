import type { AsyncSearchStore, SearchDocument, SearchOptions, SearchResult } from "@mirk/store/search";

export interface SurrealConnection {
  query<T>(surql: string, bindings?: Record<string, unknown>): Promise<T>;
}

export interface SurrealSearchOptions {
  unsupportedReason?: string;
}

const UNSUPPORTED_REASON =
  "SurrealSearchAdapter is intentionally unsupported until the Surreal package shell can prove Mirk's weighted multi-field BM25 contract without client-side full scans. SurrealDB full-text indexes are single-field indexes; Mirk search requires stable collection schemas plus query-time field weights across fields.";

export class SurrealSearchAdapter implements AsyncSearchStore {
  private constructor(private readonly reason: string) {}

  static async open(_connection: SurrealConnection, options: SurrealSearchOptions = {}): Promise<SurrealSearchAdapter> {
    return new SurrealSearchAdapter(options.unsupportedReason ?? UNSUPPORTED_REASON);
  }

  async index<M extends Record<string, unknown> = Record<string, unknown>>(
    _collection: string,
    _doc: SearchDocument<M>,
  ): Promise<void> {
    throw new Error(this.reason);
  }

  async indexMany<M extends Record<string, unknown> = Record<string, unknown>>(
    _collection: string,
    _docs: ReadonlyArray<SearchDocument<M>>,
  ): Promise<void> {
    throw new Error(this.reason);
  }

  async remove(_collection: string, _id: string): Promise<boolean> {
    throw new Error(this.reason);
  }

  async search<M extends Record<string, unknown> = Record<string, unknown>>(
    _collection: string,
    _query: string,
    _opts?: SearchOptions,
  ): Promise<SearchResult<M>[]> {
    throw new Error(this.reason);
  }
}
