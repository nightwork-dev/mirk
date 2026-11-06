import { checkMemoryAdmission, registerMemoryParticipant } from "../memory-participant.js";
import type { JsonCompatible, JsonValue } from "../atomic.js";
import type { LogEntry, LogListOptions, LogStore } from "./types.js";
import { assertSequence, assertStream, encodeRecord, listBounds } from "./validate.js";

/** The in-memory reference log. Records are kept as their JSON text, so a
 *  read returns a fresh copy, exactly as the SQLite adapter does. */
export class InMemoryLogStore implements LogStore {
  readonly #streams = new Map<string, string[]>();

  constructor() {
    registerMemoryParticipant(this, {
      checkpoint: () => this.checkpoint(),
      restore: (state) => this.restore(state as Map<string, string[]>),
    });
  }

  append(stream: string, record: JsonValue): number;
  append<T>(stream: string, record: T & JsonCompatible<T>): number;
  append(stream: string, record: unknown): number {
    checkMemoryAdmission(this);
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
    checkMemoryAdmission(this);
    assertStream(stream);
    assertSequence(sequence);
    const text = this.#streams.get(stream)?.[sequence - 1];
    return text === undefined ? null : { sequence, record: JSON.parse(text) as T };
  }

  list<T = JsonValue>(stream: string, options?: LogListOptions): LogEntry<T>[] {
    checkMemoryAdmission(this);
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

  deleteStream(stream: string): boolean {
    checkMemoryAdmission(this);
    assertStream(stream);
    return this.#streams.delete(stream);
  }

  lastSequence(stream: string): number {
    checkMemoryAdmission(this);
    assertStream(stream);
    return this.#streams.get(stream)?.length ?? 0;
  }

  private checkpoint(): Map<string, string[]> {
    return new Map([...this.#streams].map(([stream, entries]) => [stream, [...entries]]));
  }

  private restore(checkpoint: Map<string, string[]>): void {
    this.#streams.clear();
    for (const [stream, entries] of checkpoint) this.#streams.set(stream, [...entries]);
  }

  /** Run `work` so that every append it makes is undone if it throws, the
   *  in-memory counterpart of the SQLite adapter's `transaction()`. A
   *  rolled-back append's sequence goes to the next append. */
  transaction<T>(work: () => T): T {
    checkMemoryAdmission(this);
    const checkpoint = this.checkpoint();
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
      this.restore(checkpoint);
      throw error;
    }
  }
}
