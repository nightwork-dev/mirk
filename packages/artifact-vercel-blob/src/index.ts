// ─── @mirk/artifact-vercel-blob ─────────────────────────────────────────────
// Private Vercel Blob source adapter for the ObjectStore byte port. Credentials
// and Blob URLs stay inside the adapter; no browser upload or webhook surface.

import * as blob from "@vercel/blob";
import type {
  ByteSource,
  ByteStream,
  ObjectInfo,
  ObjectPutOptions,
  ObjectStore,
} from "@mirk/artifact";
import {
  assertObjectKey,
  chunks,
  ObjectAlreadyExistsError,
  ObjectWriteIndeterminateError,
} from "@mirk/artifact";

/** The four SDK calls the adapter makes. Tests and wrappers can supply their own. */
export type VercelBlobSdk = Pick<typeof blob, "put" | "get" | "head" | "del">;

export interface VercelBlobObjectStoreOptions {
  /** A read-write token. Omit it to let the SDK use managed Vercel OIDC credentials. */
  token?: string;
  storeId?: string;
  /** Largest object `put` accepts. Defaults to 16 MiB. */
  maxBytes?: number;
  /** Limit for each SDK request, including its retries and a streamed download.
   *  Defaults to 10 seconds. */
  timeoutMs?: number;
  sdk?: VercelBlobSdk;
}

/** An `ObjectStore` on private Vercel Blob objects at deterministic keys. */
export class VercelBlobObjectStore implements ObjectStore {
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
      // The SDK has no typed duplicate-path error, and a reply can be lost after
      // the upload landed. Deleting here could remove another writer's object,
      // so every failed upload is reported as indeterminate.
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

  /** Deletes only the version observed by `head`, so a concurrent overwrite
   *  survives and surfaces as the SDK's precondition error. */
  async delete(key: string): Promise<boolean> {
    assertObjectKey(key);
    const prior = await this.head(key);
    if (!prior) return false;
    await this.sdk.del(key, { ...this.request(), ...(prior.etag ? { ifMatch: prior.etag } : {}) });
    return true;
  }
}
