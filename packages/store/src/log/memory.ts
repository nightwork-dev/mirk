import { checkMemoryAdmission, registerMemoryParticipant } from "../memory-participant.js";
import type { JsonCompatible, JsonValue } from "../atomic.js";
import type { LogCursor, LogEntry, LogListOptions, LogStore } from "./types.js";
import { assertGeneration, assertSequence, assertStream, encodeRecord, listBounds, LogInputError } from "./validate.js";

type Stream = { generation: number; entries: string[] };
type Checkpoint = { generation: number; streams: Map<string, Stream> };

export class InMemoryLogStore implements LogStore {
  readonly #streams = new Map<string, Stream>();
  #generation = 0;

  constructor() {
    registerMemoryParticipant(this, {
      checkpoint: () => this.checkpoint(),
      restore: state => this.restore(state as Checkpoint),
    });
  }
  append(stream: string, record: JsonValue): number;
  append<T>(stream: string, record: T & JsonCompatible<T>): number;
  append(stream: string, record: unknown): number {
    checkMemoryAdmission(this);
    assertStream(stream);
    const text = encodeRecord(record);
    let live = this.#streams.get(stream);
    if (!live) {
      if (this.#generation === Number.MAX_SAFE_INTEGER) throw new LogInputError("generation-exhausted", "log generation counter exhausted");
      live = { generation: ++this.#generation, entries: [] };
      this.#streams.set(stream, live);
    }
    live.entries.push(text);
    return live.entries.length;
  }
  get<T = JsonValue>(stream: string, sequence: number): LogEntry<T> | null {
    checkMemoryAdmission(this);
    assertStream(stream); assertSequence(sequence);
    const live = this.#streams.get(stream);
    const text = live?.entries[sequence - 1];
    return text === undefined ? null : { generation: live!.generation, sequence, record: JSON.parse(text) as T };
  }
  list<T = JsonValue>(stream: string, options?: LogListOptions): LogEntry<T>[] {
    checkMemoryAdmission(this); assertStream(stream);
    const { after, limit } = listBounds(options);
    const live = this.#streams.get(stream);
    assertGeneration(after, live?.generation);
    if (!live) return [];
    const start = after?.sequence ?? 0;
    const end = limit === undefined ? live.entries.length : Math.min(live.entries.length, start + limit);
    const out: LogEntry<T>[] = [];
    for (let index = start; index < end; index++) out.push({ generation: live.generation, sequence: index + 1, record: JSON.parse(live.entries[index]!) as T });
    return out;
  }
  deleteStream(stream: string): boolean {
    checkMemoryAdmission(this); assertStream(stream);
    return this.#streams.delete(stream);
  }
  lastCursor(stream: string): LogCursor | null {
    checkMemoryAdmission(this); assertStream(stream);
    const live = this.#streams.get(stream);
    return live ? { generation: live.generation, sequence: live.entries.length } : null;
  }
  lastSequence(stream: string): number { return this.lastCursor(stream)?.sequence ?? 0; }
  private checkpoint(): Checkpoint {
    return { generation: this.#generation, streams: new Map([...this.#streams].map(([stream, live]) => [stream, { generation: live.generation, entries: [...live.entries] }])) };
  }
  private restore(checkpoint: Checkpoint): void {
    this.#generation = checkpoint.generation;
    this.#streams.clear();
    for (const [stream, live] of checkpoint.streams) this.#streams.set(stream, { generation: live.generation, entries: [...live.entries] });
  }
  transaction<T>(work: () => T): T {
    checkMemoryAdmission(this);
    const checkpoint = this.checkpoint();
    try {
      const result = work();
      if (result !== null && (typeof result === "object" || typeof result === "function") && typeof (result as { then?: unknown }).then === "function") throw new TypeError("Transaction function cannot return a promise");
      return result;
    } catch (error) { this.restore(checkpoint); throw error; }
  }
}
