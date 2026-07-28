import { ArtifactCoordinator } from "@mirk/artifact";
import { StoreArtifactRepository } from "@mirk/artifact/store";
import { createNodeEngines } from "@surrealdb/node";
import { Surreal, createRemoteEngines } from "surrealdb";
import { describe, expect, it } from "vitest";

import { SurrealConnection } from "./index.js";
import { SurrealObjectStore } from "./storage.js";
import { SurrealStoreAdapter } from "./store.js";

describe("shared connection composition", () => {
  it("coordinates artifact metadata and bytes through separately opened adapters", async () => {
    const client = new Surreal({ engines: { ...createRemoteEngines(), ...createNodeEngines() } });
    const connection = await SurrealConnection.open({
      client,
      endpoint: "mem://",
      namespace: "mirk",
      database: `composition_${Date.now()}`,
    });
    try {
      const first = new ArtifactCoordinator(
        await SurrealObjectStore.open(connection),
        new StoreArtifactRepository(await SurrealStoreAdapter.open(connection)),
        { idFactory: () => "artifact-1" },
      );
      const descriptor = await first.write({
        bytes: new TextEncoder().encode("shared substrate"),
        mediaType: "text/plain",
        filename: "proof.txt",
      });

      const reopenedAdapters = new ArtifactCoordinator(
        await SurrealObjectStore.open(connection),
        new StoreArtifactRepository(await SurrealStoreAdapter.open(connection)),
      );
      const read = await reopenedAdapters.read(descriptor.id);
      expect(read?.artifact.filename).toBe("proof.txt");
      expect(await readText(read?.bytes)).toBe("shared substrate");
      expect((await reopenedAdapters.verify(descriptor.id)).ok).toBe(true);
    } finally {
      await connection.close();
      await client.close();
    }
  });
});

async function readText(source: AsyncIterable<Uint8Array> | undefined): Promise<string> {
  if (!source) throw new Error("expected artifact bytes");
  const chunks: Uint8Array[] = [];
  for await (const chunk of source) chunks.push(chunk);
  const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}
