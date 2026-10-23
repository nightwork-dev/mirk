import type { JsonCompatible, JsonValue } from "../atomic.js";
import type { LogEntry, LogListOptions, LogStore } from "./types.js";
import { assertSequence, assertStream, encodeRecord, listBounds } from "./validate.js";

/** The in-memory reference log. Records are kept as their JSON text, so a
 *  read returns a fresh copy, exactly as the SQLite adapter does. */
export class InMemoryLogStore implements LogStore {
  readonly #streams = new Map<string, string[]>();

  append(stream: string, record: JsonValue): number;
  append<T>(stream: string, record: T & JsonCompatible<T>): number;
  append(stream: string, record: unknown): number {
    assertStream(stream);
    const text = encodeRecord(record);
    let entries = this.#streams.get(stream);
    if (entries === undefined) {
      entries = [];
      this.#streams.set(stream, entries);
    }
    entries.push(text);
    return entries.length;
  }

  get<T = JsonValue>(stream: string, sequence: number): LogEntry<T> | null {
    assertStream(stream);
    assertSequence(sequence);
    const text = this.#streams.get(stream)?.[sequence - 1];
    return text === undefined ? null : { sequence, record: JSON.parse(text) as T };
  }

  list<T = JsonValue>(stream: string, options?: LogListOptions): LogEntry<T>[] {
    assertStream(stream);
    const { after, limit } = listBounds(options);
    const entries = this.#streams.get(stream) ?? [];
    const end = limit === undefined ? entries.length : Math.min(entries.length, after + limit);
    const out: LogEntry<T>[] = [];
    for (let index = after; index < end; index += 1) {
      out.push({ sequence: index + 1, record: JSON.parse(entries[index]!) as T });
    }
    return out;
  }

  lastSequence(stream: string): number {
    assertStream(stream);
    return this.#streams.get(stream)?.length ?? 0;
  }

  /** Run `work` so that every append it makes is undone if it throws, the
   *  in-memory counterpart of the SQLite adapter's `transaction()`. A
   *  rolled-back append's sequence goes to the next append. */
  transaction<T>(work: () => T): T {
    const lengths = new Map<string, number>();
    for (const [stream, entries] of this.#streams) lengths.set(stream, entries.length);
    try {
      const result = work();
      if (
        result !== null &&
        (typeof result === "object" || typeof result === "function") &&
        typeof (result as { then?: unknown }).then === "function"
      ) {
        throw new TypeError("Transaction function cannot return a promise");
      }
      return result;
    } catch (error) {
      for (const [stream, entries] of this.#streams) {
        const length = lengths.get(stream);
        if (length === undefined) this.#streams.delete(stream);
        else entries.length = length;
      }
      throw error;
    }
  }
}
