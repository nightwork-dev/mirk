import { createReadStream } from "node:fs";
import { mkdir, open, rm, stat } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";

import type { ByteSource, ByteStream, ObjectInfo, ObjectPutOptions, ObjectStore } from "./types.js";
import { ObjectAlreadyExistsError } from "./memory.js";
import { assertObjectKey, chunks } from "./util.js";

/**
 * Filesystem-backed {@link ObjectStore} — durable object bytes on local disk,
 * with zero non-builtin dependencies (only `node:fs`/`node:path`). The
 * lightweight durable backend for single-host deployments; reach for
 * `@mirk/artifact-opendal` when you need S3/GCS/R2, or a store-adapter-backed
 * object store when bytes should live in the same engine as the rest of Mirk.
 *
 * Node-only: imported via the `@mirk/artifact/fs` subpath so the package root
 * stays free of `node:` builtins and safe for browser/edge bundles.
 *
 * Layout: each object is two files under `root`, named from its (validated,
 * relative) key — `<key>.bin` holds the bytes, `<key>.sidecar.json` holds the
 * {@link ObjectInfo} (mediaType/metadata a filesystem can't carry natively).
 * The `.bin` suffix means a byte-file and a nested key directory never collide
 * (key `a` → `a.bin`; key `a/b` → `a/b.bin` under dir `a/`).
 */
export interface FileObjectStoreOptions {
  /** Root directory for stored objects. Created on first write if absent. */
  root: string;
}

const BYTES_SUFFIX = ".bin";
const SIDECAR_SUFFIX = ".sidecar.json";

export class FileObjectStore implements ObjectStore {
  readonly #root: string;

  constructor(options: FileObjectStoreOptions) {
    this.#root = resolve(options.root);
  }

  async put(key: string, source: ByteSource, options: ObjectPutOptions = {}): Promise<ObjectInfo> {
    assertObjectKey(key);
    const bytesPath = this.#path(key, BYTES_SUFFIX);
    await mkdir(dirname(bytesPath), { recursive: true });

    // `wx` gives atomic exclusive-create for ifAbsent; `w` truncates/overwrites.
    let handle;
    try {
      handle = await open(bytesPath, options.ifAbsent ? "wx" : "w");
    } catch (error) {
      if (options.ifAbsent && (error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new ObjectAlreadyExistsError(key);
      }
      throw error;
    }

    let sizeBytes = 0;
    try {
      for await (const chunk of chunks(source)) {
        await handle.write(chunk);
        sizeBytes += chunk.byteLength;
      }
    } finally {
      await handle.close();
    }

    const info: ObjectInfo = {
      key,
      sizeBytes,
      ...(options.mediaType ? { mediaType: options.mediaType } : {}),
      ...(options.metadata ? { metadata: { ...options.metadata } } : {}),
    };
    await this.#writeSidecar(key, info);
    return info;
  }

  async get(key: string): Promise<ByteStream | undefined> {
    assertObjectKey(key);
    const bytesPath = this.#path(key, BYTES_SUFFIX);
    if (!(await this.#exists(bytesPath))) return undefined;
    return (async function* (): ByteStream {
      // createReadStream(...,{}) yields Buffer chunks, which are Uint8Array.
      for await (const chunk of createReadStream(bytesPath)) {
        yield chunk as Uint8Array;
      }
    })();
  }

  async head(key: string): Promise<ObjectInfo | undefined> {
    assertObjectKey(key);
    const sidecar = await this.#readSidecar(key);
    if (sidecar) return sidecar;
    // Sidecar missing but bytes present (e.g. externally seeded): synthesize
    // the minimum ObjectInfo from the byte file's size.
    const bytesPath = this.#path(key, BYTES_SUFFIX);
    const stats = await stat(bytesPath).catch(() => undefined);
    return stats?.isFile() ? { key, sizeBytes: stats.size } : undefined;
  }

  async delete(key: string): Promise<boolean> {
    assertObjectKey(key);
    const bytesPath = this.#path(key, BYTES_SUFFIX);
    const existed = await this.#exists(bytesPath);
    await rm(bytesPath, { force: true });
    await rm(this.#path(key, SIDECAR_SUFFIX), { force: true });
    return existed;
  }

  /** Resolve a suffixed key to an absolute path, refusing any escape from root.
   *  `assertObjectKey` already forbids `..`/absolute keys; this is defense in
   *  depth so a store can never write outside its own directory. */
  #path(key: string, suffix: string): string {
    const full = resolve(this.#root, key + suffix);
    if (full !== this.#root && !full.startsWith(this.#root + sep)) {
      throw new TypeError(`object key escapes store root: ${JSON.stringify(key)}`);
    }
    return full;
  }

  async #writeSidecar(key: string, info: ObjectInfo): Promise<void> {
    const path = this.#path(key, SIDECAR_SUFFIX);
    await mkdir(dirname(path), { recursive: true });
    const handle = await open(path, "w");
    try {
      await handle.write(JSON.stringify(info));
    } finally {
      await handle.close();
    }
  }

  async #readSidecar(key: string): Promise<ObjectInfo | undefined> {
    const path = this.#path(key, SIDECAR_SUFFIX);
    const handle = await open(path, "r").catch(() => undefined);
    if (!handle) return undefined;
    try {
      const text = await handle.readFile("utf-8");
      return JSON.parse(text) as ObjectInfo;
    } finally {
      await handle.close();
    }
  }

  async #exists(path: string): Promise<boolean> {
    const stats = await stat(path).catch(() => undefined);
    return stats?.isFile() ?? false;
  }
}
