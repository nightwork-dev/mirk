import { Buffer } from "node:buffer";
import type { ArtifactDigest, ByteSource, ByteStream, ObjectInfo, ObjectPutOptions, ObjectStore } from "@mirk/artifact";
import { assertObjectKey, chunks } from "@mirk/artifact";
import type { Metadata, Operator } from "opendal";

export interface OpenDalObjectStoreOptions {
  /** Optional SHA-256 metadata key written alongside objects. */
  digestMetadataKey?: string;
}

/**
 * A deliberately thin OpenDAL binding. OpenDAL owns backend clients, streaming,
 * retries, multipart behavior, and vendor transport; this class only translates
 * the Mirk ObjectStore contract and rejects unsupported conditional writes.
 */
export class OpenDalObjectStore implements ObjectStore {
  readonly #digestMetadataKey: string;
  constructor(readonly operator: Operator, options: OpenDalObjectStoreOptions = {}) {
    this.#digestMetadataKey = options.digestMetadataKey ?? "mirk-sha256";
    const capability = operator.capability();
    if (!capability.read || !capability.write || !capability.stat || !capability.delete) {
      throw new Error("OpenDAL operator must support read, write, stat, and delete");
    }
  }

  async put(key: string, source: ByteSource, options: ObjectPutOptions = {}): Promise<ObjectInfo> {
    assertObjectKey(key);
    const capability = this.operator.capability();
    if (options.ifAbsent && !capability.writeWithIfNotExists) {
      throw new Error("OpenDAL backend does not support atomic ifAbsent writes");
    }
    if (options.mediaType && !capability.writeWithContentType) {
      throw new Error("OpenDAL backend does not support content type metadata");
    }
    if (options.metadata && !capability.writeWithUserMetadata) {
      throw new Error("OpenDAL backend does not support user metadata");
    }
    const writer = await this.operator.writer(key, {
      ...(options.ifAbsent ? { ifNotExists: true } : {}),
      ...(options.mediaType ? { contentType: options.mediaType } : {}),
      ...(options.metadata ? { userMetadata: options.metadata } : {}),
    });
    try {
      for await (const chunk of chunks(source)) {
        await writer.write(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
      }
      await writer.close();
    } catch (error) {
      // A failed conditional write may mean the object pre-existed. Never
      // "clean it up" and accidentally delete another writer's object.
      if (!options.ifAbsent) await this.operator.delete(key).catch(() => undefined);
      throw error;
    }
    return metadataToInfo(key, await this.operator.stat(key), this.#digestMetadataKey);
  }

  async get(key: string): Promise<ByteStream | undefined> {
    assertObjectKey(key);
    if (!await this.operator.exists(key)) return undefined;
    const reader = await this.operator.reader(key);
    const stream = reader.createReadStream();
    return (async function* () {
      for await (const chunk of stream) {
        const bytes = chunk instanceof Uint8Array ? chunk : Buffer.from(chunk);
        yield new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      }
    })();
  }

  async head(key: string): Promise<ObjectInfo | undefined> {
    assertObjectKey(key);
    if (!await this.operator.exists(key)) return undefined;
    return metadataToInfo(key, await this.operator.stat(key), this.#digestMetadataKey);
  }

  async delete(key: string): Promise<boolean> {
    assertObjectKey(key);
    if (!await this.operator.exists(key)) return false;
    await this.operator.delete(key);
    return true;
  }
}

function metadataToInfo(key: string, metadata: Metadata, digestMetadataKey: string): ObjectInfo {
  const userMetadata = metadata.userMetadata ?? undefined;
  const digestValue = userMetadata?.[digestMetadataKey];
  const digest: ArtifactDigest | undefined = digestValue ? { algorithm: "sha256", value: digestValue } : undefined;
  const lastModifiedAt = metadata.lastModified ? Date.parse(metadata.lastModified) : undefined;
  return {
    key,
    sizeBytes: Number(metadata.contentLength ?? 0n),
    ...(metadata.contentType ? { mediaType: metadata.contentType } : {}),
    ...(digest ? { digest } : {}),
    ...(metadata.etag ? { etag: metadata.etag } : {}),
    ...(lastModifiedAt !== undefined && Number.isFinite(lastModifiedAt) ? { lastModifiedAt } : {}),
    ...(userMetadata ? { metadata: userMetadata } : {}),
  };
}
