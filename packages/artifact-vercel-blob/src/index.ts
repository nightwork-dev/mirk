// ─── @mirk/artifact-vercel-blob ─────────────────────────────────────────────
// Private Vercel Blob source adapter for the ObjectStore byte port. Credentials
// and Blob URLs stay inside the adapter; no browser upload or webhook surface.

import * as blob from "@vercel/blob";
import type {
  ByteSource,
  ByteStream,
  ListableObjectStore,
  ObjectInfo,
  ObjectPutOptions,
} from "@mirk/artifact";
import {
  assertObjectKey,
  chunks,
  ObjectAlreadyExistsError,
  ObjectWriteIndeterminateError,
} from "@mirk/artifact";

/** The SDK calls the adapter makes. Tests and wrappers can supply their own. */
export type VercelBlobSdk = Pick<typeof blob, "put" | "get" | "head" | "del" | "list">;

export type VercelBlobObjectStoreErrorCode = "missing-etag";

/** Thrown when the adapter refuses an operation it cannot perform safely. */
export class VercelBlobObjectStoreError extends Error {
  declare readonly name: "VercelBlobObjectStoreError";
  constructor(readonly code: VercelBlobObjectStoreErrorCode, message: string) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
Object.defineProperty(VercelBlobObjectStoreError.prototype, "name", {
  value: "VercelBlobObjectStoreError",
  writable: true,
  configurable: true,
  enumerable: false,
});

/** The service's refusal of an `allowOverwrite: false` upload to an existing
 *  pathname. The SDK reports it as a plain `BlobError`. */
function isExistingPathRefusal(error: unknown): boolean {
  return error instanceof blob.BlobError && /already exists/i.test(error.message);
}

/** Refusals of the request itself. The service rejects every attempt of such a
 *  request the same way, so none of its bytes were stored. */
function isRequestRefusal(error: unknown): boolean {
  return (
    error instanceof blob.BlobAccessError ||
    error instanceof blob.BlobStoreNotFoundError ||
    error instanceof blob.BlobStoreSuspendedError ||
    error instanceof blob.BlobContentTypeNotAllowedError ||
    error instanceof blob.BlobFileTooLargeError ||
    error instanceof blob.BlobPathnameMismatchError ||
    error instanceof blob.BlobClientTokenExpiredError
  );
}

export interface VercelBlobObjectStoreOptions {
  /** A read-write token. Omit it to let the SDK use managed Vercel OIDC credentials. */
  token?: string;
  storeId?: string;
  /** Largest object `put` accepts. Defaults to 16 MiB. */
  maxBytes?: number;
  /** Limit for each SDK request, including its retries and a streamed download.
   *  Defaults to 10 seconds. */
  timeoutMs?: number;
  /** Objects per `list` request. Defaults to 1000, the service maximum. */
  listPageSize?: number;
  sdk?: VercelBlobSdk;
}

/** An `ObjectStore` on private Vercel Blob objects at deterministic keys. */
export class VercelBlobObjectStore implements ListableObjectStore {
  private readonly sdk: VercelBlobSdk;
  private readonly maxBytes: number;

  constructor(private readonly options: VercelBlobObjectStoreOptions = {}) {
    this.sdk = options.sdk ?? blob;
    this.maxBytes = options.maxBytes ?? 16 * 1024 * 1024;
    if (!Number.isSafeInteger(this.maxBytes) || this.maxBytes < 1) {
      throw new RangeError("maxBytes must be a positive safe integer");
    }
  }

  private request() {
    return {
      abortSignal: AbortSignal.timeout(this.options.timeoutMs ?? 10_000),
      ...(this.options.token ? { token: this.options.token } : {}),
      ...(this.options.storeId ? { storeId: this.options.storeId } : {}),
    };
  }

  async put(key: string, bytes: ByteSource, options: ObjectPutOptions = {}): Promise<ObjectInfo> {
    assertObjectKey(key);
    if (options.metadata && Object.keys(options.metadata).length > 0) {
      throw new TypeError(
        "Vercel Blob cannot persist arbitrary object metadata; keep it in the artifact repository",
      );
    }
    if (options.ifAbsent && (await this.head(key))) throw new ObjectAlreadyExistsError(key);
    let sizeBytes = 0;
    let consumed = false;
    let sourceError: { error: unknown } | undefined;
    const iterator = chunks(bytes)[Symbol.asyncIterator]();
    const stream = new ReadableStream<Uint8Array>(
      {
        pull: async (controller) => {
          try {
            const next = await iterator.next();
            if (next.done) {
              consumed = true;
              controller.close();
              return;
            }
            sizeBytes += next.value.byteLength;
            if (sizeBytes > this.maxBytes) {
              throw new RangeError("Object exceeds the configured byte limit");
            }
            controller.enqueue(next.value);
          } catch (error) {
            sourceError = { error };
            controller.error(error);
          }
        },
        cancel: async () => {
          await iterator.return?.();
        },
      },
      { highWaterMark: 0 },
    );
    try {
      const result = await this.sdk.put(key, stream, {
        ...this.request(),
        access: "private",
        addRandomSuffix: false,
        allowOverwrite: !options.ifAbsent,
        ...(options.mediaType ? { contentType: options.mediaType } : {}),
      });
      if (!consumed) throw new Error("The Blob SDK did not consume the whole byte source");
      return { key, sizeBytes, mediaType: result.contentType, etag: result.etag };
    } catch (error) {
      await iterator.return?.().catch(() => undefined);
      // The body failed before it was complete, so the upload never finished.
      if (sourceError) throw sourceError.error;
      // A stream body is sent once: the SDK cannot replay it on a retry, so a
      // refusal of the existing pathname answers this upload, not an earlier
      // attempt of it. Our bytes did not land.
      if (options.ifAbsent && isExistingPathRefusal(error)) {
        throw new ObjectAlreadyExistsError(key);
      }
      if (isRequestRefusal(error)) throw error;
      // Anything else may have failed after the bytes reached the service,
      // such as a lost reply. Deleting could remove another writer's object.
      throw new ObjectWriteIndeterminateError(key, { cause: error });
    }
  }

  async get(key: string): Promise<ByteStream | undefined> {
    assertObjectKey(key);
    const result = await this.sdk.get(key, { ...this.request(), access: "private", useCache: false });
    if (!result) return undefined;
    if (result.statusCode !== 200 || !result.stream) {
      throw new Error("Unexpected private Blob read response");
    }
    const stream = result.stream;
    return (async function* () {
      const reader = stream.getReader();
      try {
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          yield next.value;
        }
      } finally {
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
    })();
  }

  async head(key: string): Promise<ObjectInfo | undefined> {
    assertObjectKey(key);
    try {
      const result = await this.sdk.head(key, this.request());
      return {
        key,
        sizeBytes: result.size,
        mediaType: result.contentType,
        etag: result.etag,
        lastModifiedAt: result.uploadedAt.getTime(),
      };
    } catch (error) {
      if (error instanceof blob.BlobNotFoundError) return undefined;
      throw error;
    }
  }

  /** Deletes only the version observed by `head`. Returns `false` when there
   *  is nothing to delete: the key is missing, another deleter won, or a
   *  concurrent overwrite replaced the object, which is kept. */
  async delete(key: string): Promise<boolean> {
    assertObjectKey(key);
    const prior = await this.head(key);
    if (!prior) return false;
    if (!prior.etag) {
      throw new VercelBlobObjectStoreError(
        "missing-etag",
        `Refusing to delete ${key}: the service returned no ETag to make the delete conditional`,
      );
    }
    try {
      await this.sdk.del(key, { ...this.request(), ifMatch: prior.etag });
    } catch (error) {
      if (error instanceof blob.BlobNotFoundError || error instanceof blob.BlobPreconditionFailedError) {
        return false;
      }
      throw error;
    }
    return true;
  }

  /** Every object under `prefix`, in key order, across as many pages as needed. */
  async list(prefix = ""): Promise<readonly ObjectInfo[]> {
    if (prefix) assertObjectKey(prefix);
    const objects: ObjectInfo[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.sdk.list({
        ...this.request(),
        limit: this.options.listPageSize ?? 1000,
        ...(prefix ? { prefix } : {}),
        ...(cursor ? { cursor } : {}),
      });
      for (const item of page.blobs) {
        objects.push({
          key: item.pathname,
          sizeBytes: item.size,
          etag: item.etag,
          lastModifiedAt: item.uploadedAt.getTime(),
        });
      }
      cursor = page.hasMore ? page.cursor : undefined;
    } while (cursor);
    return objects.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  }
}
