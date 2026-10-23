import type { JsonCompatible, JsonValue } from "../atomic.js";
import type { AsyncLogStore, LogEntry, LogListOptions, LogStore } from "./types.js";

class AsyncLogStoreAdapter implements AsyncLogStore {
  constructor(private readonly sync: LogStore) {}

  append(stream: string, record: JsonValue): Promise<number>;
  append<T>(stream: string, record: T & JsonCompatible<T>): Promise<number>;
  async append(stream: string, record: unknown): Promise<number> {
    return this.sync.append(stream, record as JsonValue);
  }

  async get<T = JsonValue>(stream: string, sequence: number): Promise<LogEntry<T> | null> {
    return this.sync.get<T>(stream, sequence);
  }

  async list<T = JsonValue>(stream: string, options?: LogListOptions): Promise<LogEntry<T>[]> {
    return this.sync.list<T>(stream, options);
  }

  async lastSequence(stream: string): Promise<number> {
    return this.sync.lastSequence(stream);
  }
}

/** Lift a synchronous LogStore to the {@link AsyncLogStore} interface. */
export function toAsyncLog(store: LogStore): AsyncLogStore {
  return new AsyncLogStoreAdapter(store);
}
