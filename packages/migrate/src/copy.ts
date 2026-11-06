import type { ObjectStore } from "@mirk/artifact";
import type { AsyncStore, AsyncSearchStore } from "@mirk/store";
import type { MigrationOptions, SearchManifestEntry, GraphManifestEntry, ObjectManifestEntry } from "./types.js";
import { prepareMigration, resumeAt, incrementProcessed, checkpoint, type PreparedMigration } from "./checkpoints.js";
import { MigrationError } from "./errors.js";

const copyCollectionPrepared = async (
  source: AsyncStore,
  destination: AsyncStore,
  collection: string,
  prepared: PreparedMigration
): Promise<number> => {
  const lane = `collection:${collection}`;
  let processed = resumeAt(prepared, lane);

  while (true) {
    const items = await source.list<{ id: string }>(collection, {
      sortBy: "id",
      sortDir: "asc",
      offset: processed,
      limit: prepared.batchSize,
    });
    if (items.length === 0) return processed;
    for (const item of items) await destination.put(collection, item);
    processed = incrementProcessed(processed, items.length);
    await checkpoint(prepared, { lane, collection, processed });
    if (items.length < prepared.batchSize) return processed;
  }
};

export async function copyCollection(
  source: AsyncStore,
  destination: AsyncStore,
  collection: string,
  options: MigrationOptions = {}
): Promise<number> {
  return copyCollectionPrepared(
    source,
    destination,
    collection,
    prepareMigration(options)
  );
}

export async function migrateStore(
  source: AsyncStore,
  destination: AsyncStore,
  collections: readonly string[],
  options: MigrationOptions = {}
): Promise<Record<string, number>> {
  if (!Array.isArray(collections))
    throw new MigrationError("invalid-collections", "collections must be an array");
  const seenCollections = new Set<string>();
  for (const collection of collections) {
    if (typeof collection !== "string")
      throw new MigrationError("invalid-collections", "collection must be a string");
    if (seenCollections.has(collection))
      throw new MigrationError("duplicate-collection", `duplicate migration collection ${collection}`);
    seenCollections.add(collection);
  }
  const prepared = prepareMigration(options);
  const result: Array<[string, number]> = [];
  for (const collection of collections) {
    result.push([
      collection,
      await copyCollectionPrepared(source, destination, collection, prepared),
    ]);
  }
  return Object.fromEntries(result);
}

export async function copyManifest<T>(
  lane: string,
  entries: AsyncIterable<T>,
  write: (entry: T) => Promise<unknown>,
  prepared: PreparedMigration
): Promise<number> {
  const start = resumeAt(prepared, lane);
  let seen = 0;
  let processed = start;
  let sinceCheckpoint = 0;

  for await (const entry of entries) {
    if (seen++ < start) continue;
    await write(entry);
    processed = incrementProcessed(processed, 1);
    sinceCheckpoint++;
    if (sinceCheckpoint === prepared.batchSize) {
      await checkpoint(prepared, { lane, processed });
      sinceCheckpoint = 0;
    }
  }
  if (sinceCheckpoint > 0) await checkpoint(prepared, { lane, processed });
  return processed;
}

export const copySearchManifest = (
  entries: AsyncIterable<SearchManifestEntry>,
  destination: AsyncSearchStore,
  options: MigrationOptions = {}
): Promise<number> => {
  const prepared = prepareMigration(options);
  return copyManifest(
    "search",
    entries,
    ({ collection, document }) => destination.index(collection, document),
    prepared
  );
};

export const copyGraphManifest = (
  entries: AsyncIterable<GraphManifestEntry>,
  destination: AsyncStore,
  options: MigrationOptions = {}
): Promise<number> => {
  const prepared = prepareMigration(options);
  return copyManifest(
    "graph",
    entries,
    ({ collection, edge }) => destination.put(collection, edge),
    prepared
  );
};

export const copyObjectManifest = (
  entries: AsyncIterable<ObjectManifestEntry>,
  destination: ObjectStore,
  options: MigrationOptions = {}
): Promise<number> => {
  const prepared = prepareMigration(options);
  return copyManifest(
    "object",
    entries,
    ({ key, bytes, mediaType, metadata }) =>
      destination.put(key, bytes, { mediaType, metadata }),
    prepared
  );
};
