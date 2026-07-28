import { ObjectAlreadyExistsError, type ByteSource, type ByteStream, type ObjectInfo, type ObjectPutOptions, type ObjectStore } from "@mirk/artifact";

import { firstStatement } from "./internal/query-result.js";

export interface SurrealConnectionLike {
  query<T>(surql: string, bindings?: Record<string, unknown>): Promise<T>;
}

export interface SurrealStorageOptions {
  tablePrefix?: string;
  chunkSizeBytes?: number;
  leaseMs?: number;
  renewEveryMs?: number;
  scavengeLimit?: number;
  now?: () => number;
  idFactory?: () => string;
  tokenFactory?: () => string;
}

export class SurrealObjectStoreGenerationError extends Error {
  constructor(message: string) { super(message); this.name = "SurrealObjectStoreGenerationError"; }
}

type UploadStatus = "ok" | "missing" | "expired" | "complete";

interface StoredPointer extends ObjectInfo {
  generationId: string;
}

interface ChunkRecord {
  index: number;
  bytes: Uint8Array;
}

interface StoredUpload {
  key: string;
  generationId: string;
  uploadToken: string;
  expiresAt: number;
  mediaType?: string;
  metadata?: ObjectInfo["metadata"];
}

interface FinalizeResult {
  status: UploadStatus | "exists" | "incomplete";
  info?: ObjectInfo;
  supersededGenerationId?: string;
}

interface DeleteResult {
  deleted: boolean;
  generationId?: string;
}

const DEFAULT_CHUNK_SIZE = 64 * 1024;
const DEFAULT_LEASE_MS = 30_000;
const DEFAULT_RENEW_EVERY_MS = 10_000;
const DEFAULT_SCAVENGE_LIMIT = 50;

export class SurrealObjectStore implements ObjectStore {
  readonly #connection: SurrealConnectionLike;
  readonly #options: Required<Omit<SurrealStorageOptions, "now" | "idFactory" | "tokenFactory">> & Pick<SurrealStorageOptions, "now" | "idFactory" | "tokenFactory">;
  readonly #locks = new Map<string, Promise<void>>();
  readonly #activeReads = new Map<string, number>();
  readonly #pendingGc = new Set<string>();

  private constructor(connection: SurrealConnectionLike, options: SurrealStorageOptions = {}) {
    this.#connection = connection;
    this.#options = {
      tablePrefix: options.tablePrefix ?? "mirk_object",
      chunkSizeBytes: positiveInteger(options.chunkSizeBytes ?? DEFAULT_CHUNK_SIZE, "chunkSizeBytes"),
      leaseMs: positiveInteger(options.leaseMs ?? DEFAULT_LEASE_MS, "leaseMs"),
      renewEveryMs: positiveInteger(options.renewEveryMs ?? DEFAULT_RENEW_EVERY_MS, "renewEveryMs"),
      scavengeLimit: positiveInteger(options.scavengeLimit ?? DEFAULT_SCAVENGE_LIMIT, "scavengeLimit"),
      now: options.now,
      idFactory: options.idFactory,
      tokenFactory: options.tokenFactory,
    };
    assertIdentifier(this.#options.tablePrefix, "tablePrefix");
  }

  static async open(connection: SurrealConnectionLike, options: SurrealStorageOptions = {}): Promise<SurrealObjectStore> {
    const store = new SurrealObjectStore(connection, options);
    await store.#operation("init", { tablePrefix: store.#options.tablePrefix });
    await store.scavengeExpiredUploads();
    return store;
  }

  async put(key: string, source: ByteSource, options: ObjectPutOptions = {}): Promise<ObjectInfo> {
    assertObjectKey(key);
    await this.scavengeExpiredUploads();

    const generationId = this.#id();
    const uploadToken = this.#token();
    const now = this.#now();
    await this.#operation("createUpload", {
      generationId,
      key,
      uploadToken,
      createdAt: now,
      expiresAt: now + this.#options.leaseMs,
      mediaType: options.mediaType,
      metadata: options.metadata,
    });

    let sizeBytes = 0;
    let chunkCount = 0;
    let nextRenewalAt = now + this.#options.renewEveryMs;
    try {
      for await (const chunk of splitChunks(source, this.#options.chunkSizeBytes)) {
        const writeNow = this.#now();
        if (writeNow >= nextRenewalAt) {
          const renewed = await this.#operation<boolean>("renewUpload", {
            generationId,
            uploadToken,
            now: writeNow,
            expiresAt: writeNow + this.#options.leaseMs,
          });
          if (!renewed) throw new SurrealObjectStoreGenerationError(`upload lease is no longer owned: ${generationId}`);
          nextRenewalAt = writeNow + this.#options.renewEveryMs;
        }
        await this.#operation("insertChunk", { generationId, uploadToken, index: chunkCount, bytes: chunk });
        sizeBytes += chunk.byteLength;
        chunkCount += 1;
      }

      const result = await this.#withKeyLock(key, () => this.#operation<FinalizeResult>("finalizeUpload", {
        generationId,
        key,
        uploadToken,
        now: this.#now(),
        sizeBytes,
        chunkCount,
        mediaType: options.mediaType,
        metadata: options.metadata,
        ifAbsent: options.ifAbsent === true,
      }));

      if (result.status === "exists") throw new ObjectAlreadyExistsError(key);
      if (result.status !== "ok" || !result.info) throw new SurrealObjectStoreGenerationError(`upload finalization failed: ${result.status}`);
      if (result.supersededGenerationId) await this.#gcGeneration(result.supersededGenerationId);
      return cloneJson(result.info);
    } catch (error) {
      await this.#operation("deleteUpload", { generationId, uploadToken });
      throw error;
    }
  }

  async get(key: string): Promise<ByteStream | undefined> {
    assertObjectKey(key);
    const pointer = await this.#operation<StoredPointer | undefined>("getPointer", { key });
    if (!pointer) return undefined;
    const generationId = pointer.generationId;
    this.#retainGeneration(generationId);
    return (async function* (store: SurrealObjectStore) {
      try {
        const chunks = await store.#operation<readonly ChunkRecord[]>("listChunks", { generationId });
        if (chunks.length === 0 && pointer.sizeBytes > 0) throw new SurrealObjectStoreGenerationError(`generation chunks missing: ${generationId}`);
        let sizeBytes = 0;
        for (let index = 0; index < chunks.length; index += 1) {
          const chunk = chunks[index];
          if (!chunk || chunk.index !== index) throw new SurrealObjectStoreGenerationError(`generation chunk order broken: ${generationId}`);
          sizeBytes += chunk.bytes.byteLength;
          yield chunk.bytes.slice();
        }
        if (sizeBytes !== pointer.sizeBytes) throw new SurrealObjectStoreGenerationError(`generation size changed while reading: ${generationId}`);
      } finally {
        await store.#releaseGeneration(generationId);
      }
    })(this);
  }

  async head(key: string): Promise<ObjectInfo | undefined> {
    assertObjectKey(key);
    const pointer = await this.#operation<StoredPointer | undefined>("getPointer", { key });
    return pointer ? stripGeneration(pointer) : undefined;
  }

  async delete(key: string): Promise<boolean> {
    assertObjectKey(key);
    const result = await this.#withKeyLock(key, () => this.#operation<DeleteResult>("deletePointer", { key }));
    if (result.generationId) await this.#gcGeneration(result.generationId);
    return result.deleted;
  }

  async scavengeExpiredUploads(): Promise<number> {
    const generationIds = await this.#operation<readonly string[]>("scavengeExpiredUploads", {
      now: this.#now(),
      limit: this.#options.scavengeLimit,
    });
    for (const generationId of generationIds) await this.#operation("deleteGeneration", { generationId });
    return generationIds.length;
  }

  async #gcGeneration(generationId: string): Promise<void> {
    if ((this.#activeReads.get(generationId) ?? 0) > 0) {
      this.#pendingGc.add(generationId);
      return;
    }
    const isCurrent = await this.#operation<boolean>("isCurrentGeneration", { generationId });
    if (!isCurrent) await this.#operation("deleteGeneration", { generationId });
  }

  #retainGeneration(generationId: string): void {
    this.#activeReads.set(generationId, (this.#activeReads.get(generationId) ?? 0) + 1);
  }

  async #releaseGeneration(generationId: string): Promise<void> {
    const count = (this.#activeReads.get(generationId) ?? 0) - 1;
    if (count > 0) {
      this.#activeReads.set(generationId, count);
      return;
    }
    this.#activeReads.delete(generationId);
    if (this.#pendingGc.delete(generationId)) await this.#gcGeneration(generationId);
  }

  async #withKeyLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.#locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const queued = previous.then(() => current);
    this.#locks.set(key, queued);
    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (this.#locks.get(key) === queued) this.#locks.delete(key);
    }
  }

  async #operation<T = unknown>(name: string, bindings: Record<string, unknown>): Promise<T> {
    const allBindings = {
      tablePrefix: this.#options.tablePrefix,
      pointerTable: `${this.#options.tablePrefix}_pointer`,
      uploadTable: `${this.#options.tablePrefix}_upload`,
      generationTable: `${this.#options.tablePrefix}_generation`,
      chunkTable: `${this.#options.tablePrefix}_chunk`,
      ...bindings,
    };
    switch (name) {
      case "init":
        await this.#connection.query(`DEFINE TABLE IF NOT EXISTS ${allBindings.pointerTable} SCHEMALESS`);
        await this.#connection.query(`DEFINE TABLE IF NOT EXISTS ${allBindings.uploadTable} SCHEMALESS`);
        await this.#connection.query(`DEFINE TABLE IF NOT EXISTS ${allBindings.generationTable} SCHEMALESS`);
        await this.#connection.query(`DEFINE TABLE IF NOT EXISTS ${allBindings.chunkTable} SCHEMALESS`);
        return undefined as T;
      case "createUpload":
        await this.#connection.query(
          "CREATE type::record($uploadTable, $generationId) CONTENT { generationId: $generationId, key: $key, uploadToken: $uploadToken, createdAt: $createdAt, expiresAt: $expiresAt, mediaType: $mediaType, metadata: $metadata }",
          allBindings,
        );
        return undefined as T;
      case "renewUpload": {
        const rows = firstStatement<StoredUpload[]>(
          await this.#connection.query("SELECT generationId FROM type::record($uploadTable, $generationId) WHERE uploadToken = $uploadToken", allBindings),
        );
        if (rows.length === 0) return false as T;
        await this.#connection.query("UPDATE type::record($uploadTable, $generationId) SET expiresAt = $expiresAt", allBindings);
        return true as T;
      }
      case "insertChunk": {
        const rows = firstStatement<StoredUpload[]>(
          await this.#connection.query("SELECT generationId FROM type::record($uploadTable, $generationId) WHERE uploadToken = $uploadToken", allBindings),
        );
        if (rows.length === 0) throw new SurrealObjectStoreGenerationError(`upload lease is no longer owned: ${String(bindings.generationId)}`);
        await this.#connection.query(
          "UPSERT type::record($chunkTable, $chunkId) CONTENT { generationId: $generationId, index: $index, bytes: $bytes }",
          { ...allBindings, chunkId: `${String(bindings.generationId)}:${String(bindings.index)}` },
        );
        return undefined as T;
      }
      case "finalizeUpload":
        return await this.#finalizeUpload(allBindings) as T;
      case "getPointer": {
        const rows = firstStatement<StoredPointer[]>(
          await this.#connection.query("SELECT key, generationId, sizeBytes, mediaType, metadata FROM type::record($pointerTable, $key)", allBindings),
        );
        return cleanPointer(rows[0]) as T;
      }
      case "listChunks": {
        const rows = firstStatement<ChunkRecord[]>(
          await this.#connection.query("SELECT index, bytes FROM type::table($chunkTable) WHERE generationId = $generationId ORDER BY index ASC", allBindings),
        );
        return rows.map((row) => ({ index: row.index, bytes: row.bytes instanceof Uint8Array ? row.bytes : new Uint8Array(row.bytes) })) as T;
      }
      case "deletePointer": {
        const rows = firstStatement<StoredPointer[]>(
          await this.#connection.query("DELETE type::record($pointerTable, $key) RETURN BEFORE", allBindings),
        );
        const pointer = rows[0];
        return { deleted: pointer !== undefined, ...(pointer ? { generationId: pointer.generationId } : {}) } as T;
      }
      case "isCurrentGeneration": {
        const rows = firstStatement<string[]>(
          await this.#connection.query("SELECT VALUE key FROM type::table($pointerTable) WHERE generationId = $generationId LIMIT 1", allBindings),
        );
        return (rows.length > 0) as T;
      }
      case "deleteGeneration":
        await this.#connection.query("DELETE type::record($generationTable, $generationId)", allBindings);
        await this.#connection.query("DELETE type::record($uploadTable, $generationId)", allBindings);
        await this.#connection.query("DELETE type::table($chunkTable) WHERE generationId = $generationId", allBindings);
        return undefined as T;
      case "deleteUpload": {
        const rows = firstStatement<StoredUpload[]>(
          await this.#connection.query("DELETE type::record($uploadTable, $generationId) WHERE uploadToken = $uploadToken RETURN BEFORE", allBindings),
        );
        if (rows.length > 0) await this.#connection.query("DELETE type::table($chunkTable) WHERE generationId = $generationId", allBindings);
        return undefined as T;
      }
      case "scavengeExpiredUploads": {
        const generationIds = firstStatement<string[]>(
          await this.#connection.query("SELECT VALUE generationId FROM type::table($uploadTable) WHERE expiresAt < $now LIMIT $limit", allBindings),
        );
        return generationIds as T;
      }
      default:
        throw new Error(`unknown SurrealObjectStore operation: ${name}`);
    }
  }

  async #finalizeUpload(bindings: Record<string, unknown>): Promise<FinalizeResult> {
    const upload = firstStatement<StoredUpload[]>(
      await this.#connection.query("SELECT key, generationId, uploadToken, expiresAt, mediaType, metadata FROM type::record($uploadTable, $generationId) WHERE uploadToken = $uploadToken", bindings),
    )[0];
    if (!upload) return { status: "missing" };
    if (upload.expiresAt < Number(bindings.now)) return { status: "expired" };
    const chunks = firstStatement<ChunkRecord[]>(
      await this.#connection.query("SELECT index, bytes FROM type::table($chunkTable) WHERE generationId = $generationId ORDER BY index ASC", bindings),
    );
    if (chunks.length !== Number(bindings.chunkCount)) return { status: "incomplete" };
    let sizeBytes = 0;
    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index];
      if (!chunk || chunk.index !== index) return { status: "incomplete" };
      sizeBytes += chunk.bytes.byteLength;
    }
    if (sizeBytes !== Number(bindings.sizeBytes)) return { status: "incomplete" };
    const previous = firstStatement<StoredPointer[]>(
      await this.#connection.query("SELECT generationId FROM type::record($pointerTable, $key)", bindings),
    )[0];
    if (bindings.ifAbsent === true && previous) return { status: "exists" };
    const info: ObjectInfo = {
      key: upload.key,
      sizeBytes,
      ...(upload.mediaType ? { mediaType: upload.mediaType } : {}),
      ...(upload.metadata ? { metadata: upload.metadata } : {}),
    };
    await this.#connection.query(
      "UPSERT type::record($generationTable, $generationId) CONTENT { generationId: $generationId, key: $key, sizeBytes: $sizeBytes, chunkCount: $chunkCount, mediaType: $mediaType, metadata: $metadata }",
      bindings,
    );
    await this.#connection.query(
      "UPSERT type::record($pointerTable, $key) CONTENT { key: $key, generationId: $generationId, sizeBytes: $sizeBytes, mediaType: $mediaType, metadata: $metadata }",
      bindings,
    );
    await this.#connection.query("DELETE type::record($uploadTable, $generationId)", bindings);
    return { status: "ok", info, ...(previous ? { supersededGenerationId: previous.generationId } : {}) };
  }

  #now(): number { return this.#options.now?.() ?? Date.now(); }
  #id(): string { return this.#options.idFactory?.() ?? randomId(); }
  #token(): string { return this.#options.tokenFactory?.() ?? randomId(); }
}

async function* splitChunks(source: ByteSource, chunkSize: number): ByteStream {
  for await (const chunk of chunks(source)) {
    for (let offset = 0; offset < chunk.byteLength; offset += chunkSize) yield chunk.slice(offset, offset + chunkSize);
  }
}

async function* chunks(source: ByteSource): ByteStream {
  if (source instanceof Uint8Array) {
    yield source;
    return;
  }
  for await (const chunk of source) {
    if (!(chunk instanceof Uint8Array)) throw new TypeError("object byte sources must yield Uint8Array chunks");
    yield chunk;
  }
}

function stripGeneration(pointer: StoredPointer): ObjectInfo {
  const { generationId: _generationId, ...info } = pointer;
  return cloneJson(info);
}

function cleanPointer(pointer: StoredPointer | undefined): StoredPointer | undefined {
  if (!pointer) return undefined;
  return {
    key: pointer.key,
    generationId: pointer.generationId,
    sizeBytes: pointer.sizeBytes,
    ...(pointer.mediaType ? { mediaType: pointer.mediaType } : {}),
    ...(pointer.metadata ? { metadata: pointer.metadata } : {}),
  };
}

function assertObjectKey(key: string): void {
  if (!key || key.includes("\0") || key.startsWith("/") || key.split("/").some((part) => part === ".." || part === ".")) {
    throw new TypeError(`invalid object key: ${JSON.stringify(key)}`);
  }
}

function assertIdentifier(value: string, label: string): void {
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(value)) throw new TypeError(`${label} must be a SurrealDB-safe identifier`);
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${label} must be a positive integer`);
  return value;
}

function randomId(): string {
  const cryptoApi = (globalThis as { crypto?: { randomUUID?: () => string; getRandomValues?: (bytes: Uint8Array) => Uint8Array } }).crypto;
  if (cryptoApi?.randomUUID) return cryptoApi.randomUUID();
  if (!cryptoApi?.getRandomValues) throw new Error("SurrealObjectStore requires Web Crypto or an injected idFactory/tokenFactory");
  const bytes = cryptoApi.getRandomValues(new Uint8Array(16));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
