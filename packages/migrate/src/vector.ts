import { assertDimensions, VectorInputError } from "@mirk/store/vector";
import type { AsyncVectorStore, VectorSpace } from "@mirk/store/vector";
import { prepareMigration } from "./checkpoints.js";
import { copyManifest } from "./copy.js";
import { MigrationError } from "./errors.js";
import type { MigrationOptions, VectorManifestEntry } from "./types.js";

export interface VectorManifest {
  spaces: readonly VectorSpace[];
  entries: AsyncIterable<VectorManifestEntry>;
}

export async function copyVectorManifest(
  manifest: VectorManifest,
  destination: AsyncVectorStore,
  options: MigrationOptions = {},
): Promise<number> {
  const prepared = prepareMigration(options);
  const dimensions = new Map<string, number>();
  for (const space of manifest.spaces) {
    if (!space.name || !Number.isInteger(space.dimensions) || space.dimensions <= 0 || space.metric !== "cosine" || space.encoding !== "float32") {
      throw new MigrationError("invalid-vector-manifest", "Vector manifest contains an invalid space definition");
    }
    const prior = dimensions.get(space.name);
    if (prior !== undefined && prior !== space.dimensions) throw new VectorInputError("space-definition-conflict", `Space ${space.name} already has ${prior} dimensions`);
    dimensions.set(space.name, space.dimensions);
  }
  for (const [name, size] of dimensions) await destination.ensureSpace(name, { dimensions: size });
  async function* checkedEntries(): AsyncIterable<VectorManifestEntry> {
    for await (const entry of manifest.entries) {
      if (Object.keys(entry.document.vectors).length === 0) throw new VectorInputError("empty-vectors", "A document needs at least one vector");
      for (const [name, vector] of Object.entries(entry.document.vectors)) {
        const size = dimensions.get(name);
        if (size === undefined) throw new VectorInputError("unknown-space", `Unknown vector space: ${name}`);
        assertDimensions(vector, size);
      }
      yield entry;
    }
  }
  return copyManifest("vector", checkedEntries(), ({ collection, document }) => destination.upsert(collection, document), prepared);
}
