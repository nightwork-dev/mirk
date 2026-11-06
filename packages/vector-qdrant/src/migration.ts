import { Buffer } from "node:buffer";
import type { QdrantClient, Schemas } from "@qdrant/js-client-rest";
import { bufferToVector } from "@mirk/store/vector";
import { QdrantCollectionError, QdrantVectorStore } from "./index.js";
import { pointIdFor } from "./wire.js";

export interface QdrantMigrationProgress { copied: number; total: number; complete: boolean }
export interface QdrantMigrationOptions {
  sourceCollectionName: string;
  collectionName: string;
  pageSize?: number;
  onProgress?: (progress: QdrantMigrationProgress) => void;
}

function legacyJson(payload: Record<string, unknown>, field: string): unknown {
  const value = payload[field];
  if (typeof value !== "string") throw new QdrantCollectionError(`Malformed legacy field ${field}: expected JSON text`);
  try { return JSON.parse(value) as unknown; }
  catch { throw new QdrantCollectionError(`Malformed legacy field ${field}: invalid JSON`); }
}

/** Copy with one runner and both stores quiesced; retain the source and resume a partial destination. */
export async function migrateLegacyQdrantVectors(client: QdrantClient, options: QdrantMigrationOptions): Promise<QdrantVectorStore> {
  const source = options.sourceCollectionName;
  const target = options.collectionName;
  if (source === target) throw new QdrantCollectionError("Migration destination must be a new collection");
  const sourceInfo = await client.getCollection(source);
  const params = sourceInfo.config.params.vectors;
  if (!params || !("size" in params) || typeof params.size !== "number" || params.distance !== "Dot" || (params.datatype != null && params.datatype !== "float32")) throw new QdrantCollectionError("Source must be a legacy float32 Dot collection");
  const marker = { source, complete: false };
  if (!(await client.collectionExists(target)).exists) {
    try { await client.createCollection(target, { vectors: {}, metadata: { mirkMigration: marker } }); }
    catch (error) { if (!(await client.collectionExists(target)).exists) throw error; }
  }
  const targetInfo = await client.getCollection(target);
  const persisted = targetInfo.config.metadata?.mirkMigration as { source?: string; complete?: boolean } | undefined;
  if (persisted?.source !== source) throw new QdrantCollectionError("Destination is not owned by this migration");
  if (persisted.complete) return QdrantVectorStore.open(client, { collectionName: target });
  const store = await QdrantVectorStore.openMigrationDestination(client, target);
  await store.ensureSpace("default", { dimensions: params.size });
  const total = (await client.count(source, { exact: true })).count;
  let copied = 0;
  let offset: Schemas["ExtendedPointId"] | null | undefined;
  const pageSize = options.pageSize ?? 256;
  if (!Number.isInteger(pageSize) || pageSize <= 0) throw new QdrantCollectionError("Migration pageSize must be a positive integer");
  do {
    const page = await client.scroll(source, { limit: pageSize, offset: offset ?? undefined, with_payload: true, with_vector: false });
    for (const point of page.points) {
      const payload = point.payload;
      if (!payload || typeof payload._mirk_collection !== "string" || typeof payload._mirk_id !== "string" || typeof payload._mirk_vector !== "string") throw new QdrantCollectionError("Malformed legacy point");
      const collection = legacyJson(payload, "_mirk_collection");
      const id = legacyJson(payload, "_mirk_id");
      if (typeof collection !== "string" || typeof id !== "string" || point.id !== pointIdFor(collection, id)) throw new QdrantCollectionError("Malformed legacy point identity");
      const bytes = Buffer.from(payload._mirk_vector, "base64");
      if (bytes.toString("base64") !== payload._mirk_vector || bytes.byteLength !== params.size * 4) throw new QdrantCollectionError("Malformed legacy vector bytes");
      if (typeof payload._mirk_has_metadata !== "boolean") throw new QdrantCollectionError("Malformed legacy metadata presence flag");
      const decodedMetadata = payload._mirk_has_metadata ? legacyJson(payload, "_mirk_metadata") : undefined;
      if (decodedMetadata !== undefined && (decodedMetadata === null || typeof decodedMetadata !== "object" || Array.isArray(decodedMetadata))) throw new QdrantCollectionError("Malformed legacy metadata: expected JSON object");
      if (!payload._mirk_has_metadata && "_mirk_metadata" in payload) throw new QdrantCollectionError("Malformed legacy metadata: present without its flag");
      const metadata = decodedMetadata as Record<string, unknown> | undefined;
      await store.upsert(collection, { id, vectors: { default: bufferToVector(bytes) }, ...(metadata === undefined ? {} : { metadata }) });
      copied += 1;
    }
    options.onProgress?.({ copied, total, complete: false });
    const next = page.next_page_offset;
    if (next != null && typeof next !== "string" && typeof next !== "number") throw new QdrantCollectionError("Invalid migration cursor");
    offset = next;
  } while (offset !== null && offset !== undefined);
  if (copied !== total || (await client.count(target, { exact: true })).count !== total) throw new QdrantCollectionError("Migration count verification failed; resume with source writers stopped");
  await client.updateCollection(target, { metadata: { mirkMigration: { source, complete: true } } });
  options.onProgress?.({ copied, total, complete: true });
  return store;
}
