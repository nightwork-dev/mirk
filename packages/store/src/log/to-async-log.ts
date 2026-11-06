import { runMemoryOperation } from "../memory-participant.js";
import type { JsonCompatible, JsonValue } from "../atomic.js";
import type { AsyncLogStore, LogCursor, LogEntry, LogListOptions, LogStore } from "./types.js";

class AsyncLogStoreAdapter implements AsyncLogStore {
  constructor(private readonly sync: LogStore) {}

  append(stream: string, record: JsonValue): Promise<number>;
  append<T>(stream: string, record: T & JsonCompatible<T>): Promise<number>;
  async append(stream: string, record: unknown): Promise<number> {
    return runMemoryOperation(this.sync, () => this.sync.append(stream, record as JsonValue));
  }

  async get<T = JsonValue>(stream: string, sequence: number): Promise<LogEntry<T> | null> {
    return runMemoryOperation(this.sync, () => this.sync.get<T>(stream, sequence));
  }

  async list<T = JsonValue>(stream: string, options?: LogListOptions): Promise<LogEntry<T>[]> {
    return runMemoryOperation(this.sync, () => this.sync.list<T>(stream, options));
  }

  async deleteStream(stream: string): Promise<boolean> {
    return runMemoryOperation(this.sync, () => this.sync.deleteStream(stream));
  }

  async lastCursor(stream: string): Promise<LogCursor | null> {
    return runMemoryOperation(this.sync, () => this.sync.lastCursor(stream));
  }

  async lastSequence(stream: string): Promise<number> {
    return runMemoryOperation(this.sync, () => this.sync.lastSequence(stream));
  }
}

/** Lift a synchronous LogStore to the {@link AsyncLogStore} interface. */
export function toAsyncLog(store: LogStore): AsyncLogStore {
  return new AsyncLogStoreAdapter(store);
}
