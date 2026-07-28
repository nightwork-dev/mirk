import type { ByteSource, ObjectStore } from "@mirk/artifact";
import type {
  AsyncSearchStore,
  AsyncStore,
  AsyncVectorStore,
  Edge,
  SearchDocument,
  VectorDocument,
} from "@mirk/store";

export interface MigrationCheckpoint {
  lane: string;
  processed: number;
  collection?: string;
}

export interface MigrationOptions {
  batchSize?: number;
  resume?: Readonly<Record<string, number>>;
  onCheckpoint?: (checkpoint: MigrationCheckpoint) => void | Promise<void>;
}

export interface VectorManifestEntry {
  collection: string;
  document: VectorDocument;
}

export interface SearchManifestEntry {
  collection: string;
  document: SearchDocument;
}

export interface GraphManifestEntry {
  collection: string;
  edge: Edge;
}

export interface ObjectManifestEntry {
  key: string;
  bytes: ByteSource;
  mediaType?: string;
  metadata?: Record<string, string>;
}

const batchSize = (value: number | undefined): number => {
  if (value === undefined) return 100;
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error("batchSize must be a positive integer");
  return value;
};

const resumeAt = (options: MigrationOptions, lane: string): number => {
  const value = options.resume?.[lane] ?? 0;
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`invalid resume checkpoint for ${lane}`);
  return value;
};

const checkpoint = async (
  options: MigrationOptions,
  value: MigrationCheckpoint,
): Promise<void> => {
  await options.onCheckpoint?.(value);
};

export async function copyCollection(
  source: AsyncStore,
  destination: AsyncStore,
  collection: string,
  options: MigrationOptions = {},
): Promise<number> {
  const lane = `collection:${collection}`;
  const size = batchSize(options.batchSize);
  let processed = resumeAt(options, lane);

  while (true) {
    const items = await source.list<{ id: string }>(collection, {
      sortBy: "id",
      sortDir: "asc",
      offset: processed,
      limit: size,
    });
    if (items.length === 0) return processed;
    for (const item of items) await destination.put(collection, item);
    processed += items.length;
    await checkpoint(options, { lane, collection, processed });
    if (items.length < size) return processed;
  }
}

export async function migrateStore(
  source: AsyncStore,
  destination: AsyncStore,
  collections: readonly string[],
  options: MigrationOptions = {},
): Promise<Record<string, number>> {
  const result: Record<string, number> = {};
  for (const collection of collections) {
    result[collection] = await copyCollection(source, destination, collection, options);
  }
  return result;
}

async function copyManifest<T>(
  lane: string,
  entries: AsyncIterable<T>,
  write: (entry: T) => Promise<void>,
  options: MigrationOptions,
): Promise<number> {
  const start = resumeAt(options, lane);
  const size = batchSize(options.batchSize);
  let seen = 0;
  let processed = start;
  let sinceCheckpoint = 0;

  for await (const entry of entries) {
    if (seen++ < start) continue;
    await write(entry);
    processed++;
    sinceCheckpoint++;
    if (sinceCheckpoint === size) {
      await checkpoint(options, { lane, processed });
      sinceCheckpoint = 0;
    }
  }
  if (sinceCheckpoint > 0) await checkpoint(options, { lane, processed });
  return processed;
}

export const copyVectorManifest = (
  entries: AsyncIterable<VectorManifestEntry>,
  destination: AsyncVectorStore,
  options: MigrationOptions = {},
): Promise<number> => copyManifest(
  "vector",
  entries,
  ({ collection, document }) => destination.upsert(collection, document),
  options,
);

export const copySearchManifest = (
  entries: AsyncIterable<SearchManifestEntry>,
  destination: AsyncSearchStore,
  options: MigrationOptions = {},
): Promise<number> => copyManifest(
  "search",
  entries,
  ({ collection, document }) => destination.index(collection, document),
  options,
);

export const copyGraphManifest = (
  entries: AsyncIterable<GraphManifestEntry>,
  destination: AsyncStore,
  options: MigrationOptions = {},
): Promise<number> => copyManifest(
  "graph",
  entries,
  async ({ collection, edge }) => { await destination.put(collection, edge); },
  options,
);

export const copyObjectManifest = (
  entries: AsyncIterable<ObjectManifestEntry>,
  destination: ObjectStore,
  options: MigrationOptions = {},
): Promise<number> => copyManifest(
  "object",
  entries,
  async ({ key, bytes, mediaType, metadata }) => {
    await destination.put(key, bytes, { mediaType, metadata });
  },
  options,
);
