import { Buffer } from "node:buffer";
import type {
  ArtifactDigest,
  ByteSource,
  ByteStream,
  ListableObjectStore,
  ObjectInfo,
  ObjectPutOptions,
} from "@mirk/artifact";
import { assertObjectKey, chunks, digestStream } from "@mirk/artifact";
import type { Metadata, Operator } from "opendal";

export type OpenDalObjectStoreErrorCode =
  | "missing-required-capability"
  | "unsupported-if-absent"
  | "unsupported-content-type"
  | "unsupported-user-metadata"
  | "unsupported-recursive-list"
  | "invalid-backend-key";

export class OpenDalObjectStoreError extends Error {
  declare readonly name: "OpenDalObjectStoreError";
  constructor(readonly code: OpenDalObjectStoreErrorCode, message: string) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
Object.defineProperty(OpenDalObjectStoreError.prototype, "name", {
  value: "OpenDalObjectStoreError",
  writable: true,
  configurable: true,
  enumerable: false,
});

export interface OpenDalObjectStoreOptions {
  /** Optional SHA-256 metadata key written alongside objects. Enabling this
   * opt-in buffers the source once because OpenDAL metadata is fixed at writer
   * creation; the default path remains fully streaming. */
  digestMetadataKey?: string;
}

/**
 * A deliberately thin OpenDAL binding. OpenDAL owns backend clients, streaming,
 * retries, multipart behavior, and vendor transport; this class only translates
 * the Mirk ObjectStore contract and rejects unsupported conditional writes.
 */
export class OpenDalObjectStore implements ListableObjectStore {
  readonly #digestMetadataKey: string | undefined;
  constructor(
    readonly operator: Operator,
    options: OpenDalObjectStoreOptions = {}
  ) {
    this.#digestMetadataKey = options.digestMetadataKey;
    const capability = operator.capability();
    if (
      !capability.read ||
      !capability.write ||
      !capability.stat ||
      !capability.delete
    ) {
      throw new OpenDalObjectStoreError(
        "missing-required-capability",
        "OpenDAL operator must support read, write, stat, and delete"
      );
    }
  }

  async put(
    key: string,
    source: ByteSource,
    options: ObjectPutOptions = {}
  ): Promise<ObjectInfo> {
    assertObjectKey(key);
    const capability = this.operator.capability();
    if (options.ifAbsent && !capability.writeWithIfNotExists) {
      throw new OpenDalObjectStoreError(
        "unsupported-if-absent",
        "OpenDAL backend does not support atomic ifAbsent writes"
      );
    }
    if (options.mediaType && !capability.writeWithContentType) {
      throw new OpenDalObjectStoreError(
        "unsupported-content-type",
        "OpenDAL backend does not support content type metadata"
      );
    }
    if (
      (options.metadata || this.#digestMetadataKey) &&
      !capability.writeWithUserMetadata
    ) {
      throw new OpenDalObjectStoreError(
        "unsupported-user-metadata",
        "OpenDAL backend does not support user metadata"
      );
    }
    let writeSource = source;
    let digestValue: string | undefined;
    if (this.#digestMetadataKey) {
      const parts: Uint8Array[] = [];
      let size = 0;
      for await (const chunk of chunks(source)) {
        const copy = chunk.slice();
        parts.push(copy);
        size += copy.byteLength;
      }
      const buffered = new Uint8Array(size);
      let offset = 0;
      for (const part of parts) {
        buffered.set(part, offset);
        offset += part.byteLength;
      }
      digestValue = (await digestStream(buffered)).digest.value;
      writeSource = buffered;
    }
    const writer = await this.operator.writer(key, {
      ...(options.ifAbsent ? { ifNotExists: true } : {}),
      ...(options.mediaType ? { contentType: options.mediaType } : {}),
      ...(options.metadata || digestValue
        ? {
            userMetadata: {
              ...(options.metadata ?? {}),
              ...(digestValue && this.#digestMetadataKey
                ? { [this.#digestMetadataKey]: digestValue }
                : {}),
            },
          }
        : {}),
    });
    let wroteAny = false;
    try {
      for await (const chunk of chunks(writeSource)) {
        wroteAny = true;
        await writer.write(
          Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
        );
      }
    } catch (error) {
      // A failed conditional write may mean the object pre-existed. Never
      // "clean it up" and accidentally delete another writer's object.
      if (!options.ifAbsent || wroteAny)
        await this.operator.delete(key).catch(() => undefined);
      throw error;
    }
    try {
      await writer.close();
    } catch (error) {
      // Conditional existence is checked by some services at close time. At
      // that point ownership is indeterminate, so preserve the pre-existing
      // object and let the caller reconcile the failed write.
      if (!options.ifAbsent)
        await this.operator.delete(key).catch(() => undefined);
      throw error;
    }
    return metadataToInfo(
      key,
      await this.operator.stat(key),
      this.#digestMetadataKey
    );
  }

  async get(key: string): Promise<ByteStream | undefined> {
    assertObjectKey(key);
    if (!(await this.operator.exists(key))) return undefined;
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
    if (!(await this.operator.exists(key))) return undefined;
    return metadataToInfo(
      key,
      await this.operator.stat(key),
      this.#digestMetadataKey
    );
  }

  async delete(key: string): Promise<boolean> {
    assertObjectKey(key);
    if (!(await this.operator.exists(key))) return false;
    await this.operator.delete(key);
    return true;
  }

  async list(prefix = ""): Promise<readonly ObjectInfo[]> {
    if (prefix) assertObjectKey(prefix);
    const capability = this.operator.capability();
    if (!capability.list || !capability.listWithRecursive)
      throw new OpenDalObjectStoreError(
        "unsupported-recursive-list",
        "OpenDAL backend does not support recursive object listing"
      );
    // A prefix is a string prefix, not a directory: "objects/a" matches
    // "objects/a", "objects/a/b", and "objects/ab". List the directory that
    // contains it and filter; directory entries are never object keys.
    const directory = prefix.slice(0, prefix.lastIndexOf("/") + 1);
    const entries = await this.operator.list(directory, { recursive: true });
    const results: ObjectInfo[] = [];
    for (const entry of entries) {
      const metadata = entry.metadata();
      if (!metadata.isFile()) continue;
      const key = entry.path().replace(/^\/+/, "");
      try {
        assertObjectKey(key);
      } catch {
        throw new OpenDalObjectStoreError(
          "invalid-backend-key",
          "OpenDAL backend returned an invalid object key"
        );
      }
      if (!key.startsWith(prefix)) continue;
      results.push(metadataToInfo(key, metadata, this.#digestMetadataKey));
    }
    return results.sort((a, b) => compareCodePoints(a.key, b.key));
  }
}

// Mirrors `compareCodePoints` in @mirk/store's order.ts (this package does not
// depend on @mirk/store): Unicode code point order, the order every Mirk port
// lists in. Neither `localeCompare` (ICU collation) nor `<` (UTF-16 code units).
function compareCodePoints(a: string, b: string): number {
  if (a === b) return 0;
  const left = Array.from(a);
  const right = Array.from(b);
  const shared = Math.min(left.length, right.length);
  for (let i = 0; i < shared; i += 1) {
    const x = left[i]!.codePointAt(0)!;
    const y = right[i]!.codePointAt(0)!;
    if (x !== y) return x < y ? -1 : 1;
  }
  return left.length < right.length ? -1 : left.length > right.length ? 1 : 0;
}

function metadataToInfo(
  key: string,
  metadata: Metadata,
  digestMetadataKey: string | undefined
): ObjectInfo {
  const userMetadata = metadata.userMetadata ?? undefined;
  const digestValue = digestMetadataKey
    ? userMetadata?.[digestMetadataKey]
    : undefined;
  const digest: ArtifactDigest | undefined = digestValue
    ? { algorithm: "sha256", value: digestValue }
    : undefined;
  const lastModifiedAt = metadata.lastModified
    ? Date.parse(metadata.lastModified)
    : undefined;
  return {
    key,
    sizeBytes: Number(metadata.contentLength ?? 0n),
    ...(metadata.contentType ? { mediaType: metadata.contentType } : {}),
    ...(digest ? { digest } : {}),
    ...(metadata.etag ? { etag: metadata.etag } : {}),
    ...(lastModifiedAt !== undefined && Number.isFinite(lastModifiedAt)
      ? { lastModifiedAt }
      : {}),
    ...(userMetadata ? { metadata: userMetadata } : {}),
  };
}
