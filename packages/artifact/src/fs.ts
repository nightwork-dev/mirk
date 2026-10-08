import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename, rm } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";

import type {
  ByteSource,
  ByteStream,
  ListableObjectStore,
  ObjectInfo,
  ObjectPutOptions,
} from "./types.js";
import { ObjectAlreadyExistsError } from "./memory.js";
import { assertObjectKey, chunks } from "./util.js";
import { ArtifactValidationError } from "./errors.js";
import { compareCodePoints } from "@mirk/store";

export { ArtifactValidationError } from "./errors.js";
export type { ArtifactValidationErrorCode } from "./errors.js";

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
 *
 * Concurrency: unlike {@link InMemoryObjectStore}, `get()` returns a stream that
 * reads lazily from disk — it is NOT a snapshot. A concurrent `delete`/overwrite
 * of the same key while a returned stream is still being consumed may surface
 * partial or changed bytes. Callers needing isolation should drain fully before
 * mutating, or coordinate at a higher layer.
 */
export interface FileObjectStoreOptions {
  /** Root directory for stored objects. Created on first write if absent. */
  root: string;
}

const BYTES_SUFFIX = ".bin";
const SIDECAR_SUFFIX = ".sidecar.json";

export class FileObjectStore implements ListableObjectStore {
  readonly #root: string;

  constructor(options: FileObjectStoreOptions) {
    this.#root = resolve(options.root);
  }

  async put(
    key: string,
    source: ByteSource,
    options: ObjectPutOptions = {}
  ): Promise<ObjectInfo> {
    assertObjectKey(key);
    const bytesPath = this.#path(key, BYTES_SUFFIX);
    await this.#assertSafePath(bytesPath, key);
    await mkdir(dirname(bytesPath), { recursive: true });
    await this.#assertSafePath(bytesPath, key);

    // `wx` gives atomic exclusive-create for ifAbsent; `w` truncates/overwrites.
    let handle;
    try {
      const flags =
        constants.O_WRONLY |
        constants.O_CREAT |
        (options.ifAbsent ? constants.O_EXCL : constants.O_TRUNC) |
        (constants.O_NOFOLLOW ?? 0);
      handle = await open(bytesPath, flags);
    } catch (error) {
      if (
        options.ifAbsent &&
        (error as NodeJS.ErrnoException).code === "EEXIST"
      ) {
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
    } catch (error) {
      // A mid-stream failure must not leave a partial object. When we
      // exclusively created the file (ifAbsent), remove it so the key isn't
      // poisoned — a later ifAbsent put would otherwise hit EEXIST forever.
      // On overwrite we leave it: the pre-existing bytes are already gone and
      // deleting would lose data the caller may still expect on retry.
      await handle.close();
      if (options.ifAbsent) await rm(bytesPath, { force: true });
      throw error;
    } finally {
      await handle.close();
    }

    const info: ObjectInfo = {
      key,
      sizeBytes,
      ...(options.mediaType ? { mediaType: options.mediaType } : {}),
      ...(options.metadata ? { metadata: { ...options.metadata } } : {}),
    };
    try {
      await this.#writeSidecar(key, info);
    } catch (error) {
      // An ifAbsent write owns this path. Do not leave a byte object that can
      // poison the next retry when its metadata commit fails.
      if (options.ifAbsent)
        await rm(bytesPath, { force: true }).catch(() => undefined);
      throw error;
    }
    return info;
  }

  async get(key: string): Promise<ByteStream | undefined> {
    assertObjectKey(key);
    const bytesPath = this.#path(key, BYTES_SUFFIX);
    await this.#assertSafePath(bytesPath, key);
    if (!(await this.#exists(bytesPath))) return undefined;
    return (async function* (): ByteStream {
      const handle = await open(
        bytesPath,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)
      );
      try {
        const buffer = Buffer.allocUnsafe(1024 * 1024);
        while (true) {
          const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, null);
          if (bytesRead === 0) break;
          yield Uint8Array.from(buffer.subarray(0, bytesRead));
        }
      } finally {
        await handle.close();
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
    await this.#assertSafePath(bytesPath, key);
    const stats = await lstat(bytesPath).catch(() => undefined);
    return stats?.isFile() ? { key, sizeBytes: stats.size } : undefined;
  }

  async delete(key: string): Promise<boolean> {
    assertObjectKey(key);
    const bytesPath = this.#path(key, BYTES_SUFFIX);
    const sidecarPath = this.#path(key, SIDECAR_SUFFIX);
    await this.#assertSafePath(bytesPath, key);
    await this.#assertSafePath(sidecarPath, key);
    const existed = await this.#exists(bytesPath);
    await rm(bytesPath, { force: true });
    await rm(sidecarPath, { force: true });
    return existed;
  }

  async list(prefix = ""): Promise<readonly ObjectInfo[]> {
    if (prefix) assertObjectKey(prefix);
    const paths: string[] = [];
    const visit = async (directory: string): Promise<void> => {
      const entries = await readdir(directory, { withFileTypes: true }).catch(
        () => []
      );
      for (const entry of entries) {
        const path = `${directory}/${entry.name}`;
        if (entry.isDirectory()) await visit(path);
        else if (entry.isFile() && entry.name.endsWith(BYTES_SUFFIX))
          paths.push(path.slice(this.#root.length + 1, -BYTES_SUFFIX.length));
      }
    };
    await visit(this.#root);
    const filtered = paths.filter((key) => key.startsWith(prefix));
    const infos: ObjectInfo[] = [];
    for (const key of filtered) {
      const info = await this.head(key);
      if (info) infos.push(info);
    }
    return infos.sort((a, b) => compareCodePoints(a.key, b.key));
  }

  /** Resolve a suffixed key to an absolute path, refusing any escape from root.
   *  `assertObjectKey` already forbids `..`/absolute keys; this is defense in
   *  depth so a store can never write outside its own directory. */
  #path(key: string, suffix: string): string {
    const full = resolve(this.#root, key + suffix);
    if (full !== this.#root && !full.startsWith(this.#root + sep)) {
      throw new ArtifactValidationError(
        "object-key-escapes-root",
        `object key escapes store root: ${JSON.stringify(key)}`
      );
    }
    return full;
  }

  async #assertSafePath(path: string, key: string): Promise<void> {
    // This closes static symlink escapes. It does not provide a lock against a
    // hostile process replacing an ancestor after this check completes.
    const root = await realpath(this.#root).catch(() => this.#root);
    let ancestor = dirname(path);
    while (true) {
      if (ancestor === this.#root) {
        ancestor = root;
        break;
      }
      const resolvedAncestor = await realpath(ancestor).catch(() => undefined);
      if (resolvedAncestor) {
        ancestor = resolvedAncestor;
        break;
      }
      const parent = dirname(ancestor);
      if (parent === ancestor) break;
      ancestor = parent;
    }
    if (!this.#withinRoot(ancestor, root))
      throw new ArtifactValidationError(
        "object-key-escapes-root",
        `object key escapes store root: ${JSON.stringify(key)}`
      );

    const final = await lstat(path).catch(() => undefined);
    if (final?.isSymbolicLink())
      throw new ArtifactValidationError(
        "object-key-escapes-root",
        `object key escapes store root: ${JSON.stringify(key)}`
      );
    const resolved = await realpath(path).catch(() => undefined);
    if (resolved && !this.#withinRoot(resolved, root))
      throw new ArtifactValidationError(
        "object-key-escapes-root",
        `object key escapes store root: ${JSON.stringify(key)}`
      );
  }

  #withinRoot(path: string, root: string): boolean {
    return path === root || path.startsWith(root + sep);
  }

  /** Write the sidecar atomically: a unique temp file + rename (atomic on the
   *  same filesystem). A crash never leaves a truncated/partial sidecar — the
   *  reader sees either the previous complete file or the new one. */
  async #writeSidecar(key: string, info: ObjectInfo): Promise<void> {
    const path = this.#path(key, SIDECAR_SUFFIX);
    await this.#assertSafePath(path, key);
    await mkdir(dirname(path), { recursive: true });
    await this.#assertSafePath(path, key);
    const tmp = `${path}.tmp-${randomUUID()}`;
    const handle = await open(tmp, "wx");
    try {
      await handle.write(JSON.stringify(info));
    } catch (error) {
      await rm(tmp, { force: true });
      throw error;
    } finally {
      await handle.close();
    }
    try {
      await rename(tmp, path);
    } catch (error) {
      await rm(tmp, { force: true });
      throw error;
    }
  }

  async #readSidecar(key: string): Promise<ObjectInfo | undefined> {
    const path = this.#path(key, SIDECAR_SUFFIX);
    await this.#assertSafePath(path, key);
    const handle = await open(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)
    ).catch(() => undefined);
    if (!handle) return undefined;
    try {
      const text = await handle.readFile("utf-8");
      return JSON.parse(text) as ObjectInfo;
    } catch {
      // Sidecar present but unreadable/corrupt — treat as absent so head()
      // degrades to the stat-based fallback instead of throwing forever.
      return undefined;
    } finally {
      await handle.close();
    }
  }

  async #exists(path: string): Promise<boolean> {
    const stats = await lstat(path).catch(() => undefined);
    return stats?.isFile() ?? false;
  }
}
