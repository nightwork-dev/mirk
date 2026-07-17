import type { AsyncStore } from "@mirk/store/kv";
import type { ArtifactDigest, ArtifactLineageEdge, ArtifactQuery, ArtifactRepository, JsonValue, StoredArtifactPage, StoredArtifactRecord } from "./types.js";
import { ArtifactConflictError, compareRecords, cursorOffset, encodeCursor, matches } from "./memory.js";
import { assertBoundedJson, cloneJson } from "./util.js";

export interface StoreArtifactRepositoryOptions { namespace?: string; }

export class StoreArtifactRepository implements ArtifactRepository {
  readonly #records: string;
  readonly #edges: string;
  constructor(readonly store: AsyncStore, options: StoreArtifactRepositoryOptions = {}) {
    const prefix = options.namespace ?? "mirk-artifacts";
    this.#records = `${prefix}:records`;
    this.#edges = `${prefix}:lineage`;
  }
  async create(record: StoredArtifactRecord): Promise<void> {
    if (await this.get(record.id)) throw new ArtifactConflictError(`artifact already exists: ${record.id}`);
    if (record.idempotencyKey && await this.getByIdempotencyKey(record.idempotencyKey)) throw new ArtifactConflictError(`idempotency key already exists: ${record.idempotencyKey}`);
    await this.store.put(this.#records, cloneJson(record));
  }
  async get(id: string): Promise<StoredArtifactRecord | undefined> { return (await this.store.getById<StoredArtifactRecord>(this.#records, id)) ?? undefined; }
  async getByDigest(digest: ArtifactDigest): Promise<readonly StoredArtifactRecord[]> { return (await this.store.list<StoredArtifactRecord>(this.#records)).filter((record) => record.digest.algorithm === digest.algorithm && record.digest.value === digest.value); }
  async getByIdempotencyKey(key: string): Promise<StoredArtifactRecord | undefined> { return (await this.store.list<StoredArtifactRecord>(this.#records)).find((record) => record.idempotencyKey === key); }
  async list(query: ArtifactQuery = {}): Promise<StoredArtifactPage> {
    const ordered = (await this.store.list<StoredArtifactRecord>(this.#records)).filter((record) => matches(record, query)).sort(compareRecords);
    const after = cursorOffset(ordered, query.cursor);
    const limit = Math.min(Math.max(query.limit ?? 50, 1), 500);
    const items = ordered.slice(after, after + limit);
    return { items, ...(after + limit < ordered.length && items.length ? { nextCursor: encodeCursor(items[items.length - 1]!) } : {}) };
  }
  async updateAnnotations(id: string, patch: Record<string, JsonValue | undefined>): Promise<StoredArtifactRecord> {
    const record = await this.get(id);
    if (!record) throw new Error(`artifact not found: ${id}`);
    const annotations = { ...(record.annotations ?? {}) };
    for (const [key, value] of Object.entries(patch)) value === undefined ? delete annotations[key] : annotations[key] = value;
    assertBoundedJson(annotations, "annotations");
    const updated = { ...record, ...(Object.keys(annotations).length ? { annotations } : { annotations: undefined }) } as StoredArtifactRecord;
    return this.store.put(this.#records, updated);
  }
  async delete(id: string): Promise<boolean> {
    if (!await this.store.remove(this.#records, id)) return false;
    for (const edge of await this.store.list<ArtifactLineageEdge>(this.#edges)) if (edge.sourceArtifactId === id || edge.resultArtifactId === id) await this.store.remove(this.#edges, edge.id);
    return true;
  }
  async addLineage(edge: ArtifactLineageEdge): Promise<void> {
    if (await this.store.getById(this.#edges, edge.id)) throw new ArtifactConflictError(`lineage edge already exists: ${edge.id}`);
    if (!await this.get(edge.sourceArtifactId) || !await this.get(edge.resultArtifactId)) throw new Error("lineage endpoints must exist");
    if (edge.sourceArtifactId === edge.resultArtifactId || await this.#reaches(edge.resultArtifactId, edge.sourceArtifactId)) throw new ArtifactConflictError("lineage cycle forbidden");
    if (edge.parameters) assertBoundedJson(edge.parameters, "lineage parameters");
    await this.store.put(this.#edges, cloneJson(edge));
  }
  async getSources(id: string): Promise<readonly ArtifactLineageEdge[]> { return (await this.store.list<ArtifactLineageEdge>(this.#edges)).filter((edge) => edge.resultArtifactId === id); }
  async getDerivatives(id: string): Promise<readonly ArtifactLineageEdge[]> { return (await this.store.list<ArtifactLineageEdge>(this.#edges)).filter((edge) => edge.sourceArtifactId === id); }
  async #reaches(from: string, target: string, seen = new Set<string>()): Promise<boolean> { if (from === target) return true; if (seen.has(from)) return false; seen.add(from); for (const edge of await this.getDerivatives(from)) if (await this.#reaches(edge.resultArtifactId, target, seen)) return true; return false; }
}
