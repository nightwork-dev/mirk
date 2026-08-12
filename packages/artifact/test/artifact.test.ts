import { describe, expect, it } from "vitest";
import {
  ArtifactConflictError,
  ArtifactCoordinator,
  InMemoryArtifactRepository,
  InMemoryObjectStore,
  digestStream,
} from "../src/index.js";

const bytes = (text: string) => new TextEncoder().encode(text);
const readText = async (stream: AsyncIterable<Uint8Array>) =>
  new TextDecoder().decode((await digestAndCollect(stream)).collected);
async function digestAndCollect(stream: AsyncIterable<Uint8Array>) {
  const parts: Uint8Array[] = [];
  let size = 0;
  for await (const part of stream) {
    parts.push(part);
    size += part.byteLength;
  }
  const collected = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    collected.set(part, offset);
    offset += part.byteLength;
  }
  return { collected, ...(await digestStream(collected)) };
}

describe("ArtifactCoordinator", () => {
  it("streams, verifies, reads, and strips the object key", async () => {
    const coordinator = new ArtifactCoordinator(
      new InMemoryObjectStore(),
      new InMemoryArtifactRepository(),
      { namespace: "test", idFactory: () => "artifact-1", now: () => 42 }
    );
    const artifact = await coordinator.write({
      bytes: bytes("hello"),
      mediaType: "text/plain",
      filename: "hello.txt",
    });
    expect(artifact).toMatchObject({
      id: "artifact-1",
      sizeBytes: 5,
      createdAt: 42,
    });
    expect(artifact).not.toHaveProperty("objectKey");
    expect((await coordinator.verify(artifact.id)).ok).toBe(true);
    const read = await coordinator.read(artifact.id);
    expect(await readText(read!.bytes)).toBe("hello");
  });

  it("returns completed idempotent writes and rejects incompatible reuse", async () => {
    let id = 0;
    const coordinator = new ArtifactCoordinator(
      new InMemoryObjectStore(),
      new InMemoryArtifactRepository(),
      { idFactory: () => `id-${++id}` }
    );
    const first = await coordinator.write({
      bytes: bytes("one"),
      mediaType: "text/plain",
      idempotencyKey: "attempt:output",
    });
    const repeated = await coordinator.write({
      bytes: bytes("one"),
      mediaType: "text/plain",
      idempotencyKey: "attempt:output",
    });
    expect(repeated.id).toBe(first.id);
    await expect(
      coordinator.write({
        bytes: bytes("changed"),
        mediaType: "text/plain",
        idempotencyKey: "attempt:output",
      })
    ).rejects.toBeInstanceOf(ArtifactConflictError);
    await expect(
      coordinator.write({
        bytes: bytes("no"),
        mediaType: "image/png",
        idempotencyKey: "attempt:output",
      })
    ).rejects.toBeInstanceOf(ArtifactConflictError);
  });

  it("records acyclic lineage", async () => {
    let id = 0;
    const repository = new InMemoryArtifactRepository();
    const coordinator = new ArtifactCoordinator(
      new InMemoryObjectStore(),
      repository,
      { idFactory: () => `id-${++id}`, now: () => id }
    );
    const source = await coordinator.write({
      bytes: bytes("source"),
      mediaType: "text/plain",
    });
    const result = await coordinator.write({
      bytes: bytes("result"),
      mediaType: "text/plain",
      sources: [{ artifactId: source.id, operation: "text.transform" }],
    });
    expect(await repository.getSources(result.id)).toHaveLength(1);
    await expect(
      repository.addLineage({
        id: "cycle",
        sourceArtifactId: result.id,
        resultArtifactId: source.id,
        operation: "cycle",
        createdAt: 3,
      })
    ).rejects.toBeInstanceOf(ArtifactConflictError);
  });

  it("includes declared sources in the idempotency fingerprint", async () => {
    let id = 0;
    const coordinator = new ArtifactCoordinator(
      new InMemoryObjectStore(),
      new InMemoryArtifactRepository(),
      { idFactory: () => `id-${++id}` }
    );
    const sourceA = await coordinator.write({
      bytes: bytes("a"),
      mediaType: "text/plain",
    });
    const sourceB = await coordinator.write({
      bytes: bytes("b"),
      mediaType: "text/plain",
    });
    await coordinator.write({
      bytes: bytes("result"),
      mediaType: "text/plain",
      idempotencyKey: "derived",
      sources: [{ artifactId: sourceA.id, operation: "text.transform" }],
    });
    await expect(
      coordinator.write({
        bytes: bytes("result"),
        mediaType: "text/plain",
        idempotencyKey: "derived",
        sources: [{ artifactId: sourceB.id, operation: "text.transform" }],
      })
    ).rejects.toBeInstanceOf(ArtifactConflictError);
  });

  it("removes an orphan when metadata commit fails", async () => {
    const objects = new InMemoryObjectStore();
    const repository = new InMemoryArtifactRepository();
    await repository.create({
      id: "fixed",
      objectKey: "old",
      mediaType: "text/plain",
      sizeBytes: 0,
      digest: { algorithm: "sha256", value: "x" },
      createdAt: 0,
    });
    const coordinator = new ArtifactCoordinator(objects, repository, {
      idFactory: () => "fixed",
    });
    await expect(
      coordinator.write({ bytes: bytes("new"), mediaType: "text/plain" })
    ).rejects.toMatchObject({ cleanup: "succeeded" });
    expect(await objects.head("artifacts/fixed")).toBeUndefined();
  });

  it("keeps shared imported bytes until the final artifact record is deleted", async () => {
    let id = 0;
    const objects = new InMemoryObjectStore();
    await objects.put("imports/shared", bytes("shared"));
    const coordinator = new ArtifactCoordinator(
      objects,
      new InMemoryArtifactRepository(),
      { idFactory: () => `id-${++id}` }
    );
    const first = await coordinator.import({
      objectKey: "imports/shared",
      mediaType: "text/plain",
    });
    const second = await coordinator.import({
      objectKey: "imports/shared",
      mediaType: "text/plain",
    });

    expect(await coordinator.delete(first.id)).toBe(true);
    expect((await coordinator.verify(second.id)).ok).toBe(true);
    expect(await objects.head("imports/shared")).toBeDefined();

    expect(await coordinator.delete(second.id)).toBe(true);
    expect(await objects.head("imports/shared")).toBeUndefined();
  });
});
