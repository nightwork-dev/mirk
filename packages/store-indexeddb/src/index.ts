import { StoreFilterError, compareCodePoints } from "@mirk/store";
import type { AsyncStore, StoreFilter, StoreMeta } from "@mirk/store";
import type {
  AsyncAtomicMutationStore,
  AtomicCompletedMutationResult,
  AtomicMutationLimits,
  AtomicMutationRequest,
  AtomicMutationResult,
  StoreCondition,
  StoreTarget,
  StoreVersion,
  VersionedStoreValue,
} from "@mirk/store/atomic";
import {
  AtomicMutationBackendError,
  IN_PROCESS_ATOMIC_LIMITS,
  canonicalJson,
  cloneJson,
  resolveAtomicLimits,
  targetKey,
  validateAtomicRequest,
} from "@mirk/store/atomic";

/** Version 2 guarantees that every stored key and record has a version row;
 *  opening a version 1 database backfills the missing rows in the upgrade. */
const DATABASE_VERSION = 2;
const STORE_KV = "kv";
const STORE_RECORDS = "records";
const STORE_VERSIONS = "versions";
const STORE_RECEIPTS = "receipts";
const STORE_META = "meta";
const META_KEY = "state";
const COLLECTION_INDEX = "collection";
const STORE_NAMES = [
  STORE_KV,
  STORE_RECORDS,
  STORE_VERSIONS,
  STORE_RECEIPTS,
  STORE_META,
] as const;

const NON_SCALAR_FILTER_MESSAGE = "Store filters only support JSON scalar values.";

type IndexedDbStoreName = (typeof STORE_NAMES)[number];

export interface KvRow {
  key: string;
  value: unknown;
}

export interface RecordRow {
  collection: string;
  id: string;
  data: unknown;
  ordinal: number;
}

export interface VersionRow {
  targetKey: string;
  version: string;
}

export interface ReceiptRow {
  key: string;
  requestDigest: string;
  result: AtomicCompletedMutationResult & { status: "applied" };
}

export interface MetaRow {
  name: typeof META_KEY;
  versionIdentity: string;
  nextVersion: number;
  nextOrdinal: number;
}

/** A coherent, synchronous view materialized from one IndexedDB readonly transaction. */
export interface IndexedDbReadView {
  get<T>(key: string): T | null;
  has(key: string): boolean;
  keys(prefix?: string): string[];
  list<T>(collection: string, filter?: StoreFilter): T[];
  getById<T>(collection: string, id: string): T | null;
  getVersioned<T>(target: StoreTarget): VersionedStoreValue<T> | null;
}

/** A complete generic store backup: every key, record, version token,
 *  idempotency receipt, and the version/ordinal counters. */
export interface IndexedDbExport {
  schemaVersion: 1;
  dbName: string;
  meta: {
    versionIdentity: string;
    nextVersion: number;
    nextOrdinal: number;
  } | null;
  kv: KvRow[];
  records: RecordRow[];
  versions: VersionRow[];
  receipts: ReceiptRow[];
}

export interface IndexedDbImport {
  schemaVersion: 1;
  meta: IndexedDbExport["meta"];
  kv: KvRow[];
  records: RecordRow[];
  versions: VersionRow[];
  receipts: ReceiptRow[];
}

export interface IndexedDbAdapterOptions {
  /** IndexedDB database name. Defaults to `mirk`. */
  dbName?: string;
  /** In-process request bounds. Defaults to the in-process Mirk limits. */
  atomicLimits?: Partial<AtomicMutationLimits>;
  /** Prefix for version tokens, used only when the database mints its first
   *  token. Defaults to a random identity; an existing database keeps its own. */
  versionIdentity?: string;
  /** Injectable factory for an embedding with its own IndexedDB global. */
  indexedDB?: IDBFactory;
}

export type IndexedDbConnectionErrorCode =
  | "unavailable"
  | "invalid-database-name"
  | "blocked"
  | "version-too-new"
  | "open-failed"
  | "version-change"
  | "connection-lost"
  | "closed";

/** Opening the database failed, or the connection is no longer usable.
 *  `retryable` says whether calling `openIndexedDbAdapter` again can succeed. */
export class IndexedDbConnectionError extends Error {
  declare readonly name: "IndexedDbConnectionError";
  constructor(
    readonly code: IndexedDbConnectionErrorCode,
    readonly retryable: boolean,
    message: string,
  ) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
Object.defineProperty(IndexedDbConnectionError.prototype, "name", {
  value: "IndexedDbConnectionError",
  writable: true,
  configurable: true,
  enumerable: false,
});

export type IndexedDbTransactionErrorCode = "aborted" | "quota-exceeded" | "unknown";

/** @deprecated Use `IndexedDbTransactionErrorCode`. */
export type IndexedDbFailureKind = IndexedDbTransactionErrorCode;

/** A transaction failed before its completion event. `aborted` and
 *  `quota-exceeded` are known non-commit outcomes; `unknown` is a failure where
 *  retrying with the same idempotency key is the safe recovery. */
export class IndexedDbTransactionError extends Error {
  declare readonly name: "IndexedDbTransactionError";
  constructor(
    readonly code: IndexedDbTransactionErrorCode,
    readonly retryable: boolean,
    message: string,
  ) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
  }

  /** @deprecated Use `code`. */
  get kind(): IndexedDbTransactionErrorCode {
    return this.code;
  }
}
Object.defineProperty(IndexedDbTransactionError.prototype, "name", {
  value: "IndexedDbTransactionError",
  writable: true,
  configurable: true,
  enumerable: false,
});

export type IndexedDbBackupErrorCode =
  | "unsupported-schema"
  | "invalid-shape"
  | "invalid-row"
  | "duplicate-row"
  | "dangling-version"
  | "invalid-metadata"
  | "not-cloneable";

/** `importState` rejected a backup before touching the database. */
export class IndexedDbBackupError extends TypeError {
  declare readonly name: "IndexedDbBackupError";
  constructor(readonly code: IndexedDbBackupErrorCode, message: string) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
Object.defineProperty(IndexedDbBackupError.prototype, "name", {
  value: "IndexedDbBackupError",
  writable: true,
  configurable: true,
  enumerable: false,
});

export type IndexedDbStore = AsyncStore & AsyncAtomicMutationStore;

type Fail = (error: unknown) => void;

/** Open a Mirk IndexedDB database. */
export async function openIndexedDbAdapter(
  options: IndexedDbAdapterOptions = {},
): Promise<IndexedDbAdapter> {
  const factory = options.indexedDB ?? globalThis.indexedDB;
  if (!factory) {
    throw new IndexedDbConnectionError("unavailable", false, "IndexedDB is unavailable in this browser context.");
  }
  const dbName = options.dbName ?? "mirk";
  if (dbName.length === 0) {
    throw new IndexedDbConnectionError("invalid-database-name", false, "IndexedDB database name must not be empty.");
  }
  const versionIdentity = options.versionIdentity ?? randomIdentity();

  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    let request: IDBOpenDBRequest;
    try {
      request = factory.open(dbName, DATABASE_VERSION);
    } catch (error) {
      fail(openError(error));
      return;
    }
    request.onupgradeneeded = (event) => {
      const tx = request.transaction!;
      try {
        ensureSchema(request.result, tx);
        if (event.oldVersion === 1) backfillVersions(tx, versionIdentity);
      } catch (error) {
        fail(openError(error));
        try {
          tx.abort();
        } catch {
          // The upgrade transaction has already finished.
        }
      }
    };
    request.onerror = () => fail(openError(request.error));
    request.onblocked = () =>
      fail(new IndexedDbConnectionError(
        "blocked",
        true,
        `IndexedDB database ${JSON.stringify(dbName)} is blocked by another open connection.`,
      ));
    request.onsuccess = () => {
      if (settled) {
        request.result.close();
        return;
      }
      settled = true;
      resolve(request.result);
    };
  });
  return new IndexedDbAdapter(db, dbName, { ...options, versionIdentity });
}

/** IndexedDB source adapter. The `.kv` facet is the Mirk async store and atomic port. */
export class IndexedDbAdapter implements IndexedDbStore {
  readonly meta: StoreMeta = { backend: "indexeddb" };
  readonly atomicLimits: AtomicMutationLimits;
  readonly kv: IndexedDbStore;
  private unusable: IndexedDbConnectionError | null = null;
  private readonly versionIdentity: string;

  constructor(
    private readonly db: IDBDatabase,
    readonly dbName: string,
    options: IndexedDbAdapterOptions,
  ) {
    this.atomicLimits = resolveAtomicLimits(options.atomicLimits, IN_PROCESS_ATOMIC_LIMITS);
    this.versionIdentity = options.versionIdentity ?? randomIdentity();
    this.kv = this;
    db.onversionchange = () =>
      this.release(new IndexedDbConnectionError(
        "version-change",
        true,
        `IndexedDB database ${JSON.stringify(dbName)} was upgraded or deleted by another connection.`,
      ));
    db.onclose = () =>
      this.release(new IndexedDbConnectionError(
        "connection-lost",
        true,
        `IndexedDB database ${JSON.stringify(dbName)} was closed by the browser.`,
      ));
  }

  async close(): Promise<void> {
    this.release(new IndexedDbConnectionError("closed", false, "IndexedDB adapter is closed."));
  }

  async get<T>(key: string): Promise<T | null> {
    return this.run([STORE_KV], "readonly", (tx, finish, fail) => {
      onResult<KvRow | undefined>(tx.objectStore(STORE_KV).get(key), fail, (row) => {
        finish(row === undefined || row.value === undefined ? null : (row.value as T));
      });
    });
  }

  async set<T>(key: string, value: T): Promise<void> {
    return this.run([STORE_KV, STORE_VERSIONS, STORE_META], "readwrite", (tx, finish, fail) => {
      onResult<MetaRow | undefined>(tx.objectStore(STORE_META).get(META_KEY), fail, (meta) => {
        const state = meta ?? this.newMeta();
        tx.objectStore(STORE_KV).put({ key, value } satisfies KvRow);
        tx.objectStore(STORE_VERSIONS).put({
          targetKey: targetKey({ kind: "key", key }),
          version: mintVersion(state),
        } satisfies VersionRow);
        tx.objectStore(STORE_META).put(state);
        finish(undefined);
      });
    });
  }

  async has(key: string): Promise<boolean> {
    return this.run([STORE_KV], "readonly", (tx, finish, fail) => {
      onResult(tx.objectStore(STORE_KV).getKey(key), fail, (found) => finish(found !== undefined));
    });
  }

  async delete(key: string): Promise<boolean> {
    return this.run([STORE_KV, STORE_VERSIONS], "readwrite", (tx, finish, fail) => {
      onResult(tx.objectStore(STORE_KV).getKey(key), fail, (found) => {
        const existed = found !== undefined;
        if (existed) {
          tx.objectStore(STORE_KV).delete(key);
          tx.objectStore(STORE_VERSIONS).delete(targetKey({ kind: "key", key }));
        }
        finish(existed);
      });
    });
  }

  async keys(prefix?: string): Promise<string[]> {
    return this.run([STORE_KV], "readonly", (tx, finish, fail) => {
      onResult(tx.objectStore(STORE_KV).getAllKeys(), fail, (keys) => {
        const all = keys as string[];
        const selected = prefix ? all.filter((key) => key.startsWith(prefix)) : all;
        finish(selected.sort(compareCodePoints));
      });
    });
  }

  async list<T>(collection: string, filter?: StoreFilter): Promise<T[]> {
    assertCollectionName(collection);
    if (filter?.where) assertScalarWhere(filter.where);
    return this.run([STORE_RECORDS], "readonly", (tx, finish, fail) => {
      const request = tx.objectStore(STORE_RECORDS).index(COLLECTION_INDEX).getAll(collection);
      onResult<RecordRow[]>(request, fail, (rows) => finish(applyFilter<T>(rows, filter)));
    });
  }

  async getById<T>(collection: string, id: string): Promise<T | null> {
    assertCollectionName(collection);
    return this.run([STORE_RECORDS], "readonly", (tx, finish, fail) => {
      onResult<RecordRow | undefined>(tx.objectStore(STORE_RECORDS).get([collection, id]), fail, (row) => {
        finish(row === undefined || row.data === undefined ? null : (row.data as T));
      });
    });
  }

  async put<T extends { id: string }>(collection: string, item: T): Promise<T> {
    assertCollectionName(collection);
    return this.run([STORE_RECORDS, STORE_META, STORE_VERSIONS], "readwrite", (tx, finish, fail) => {
      const records = tx.objectStore(STORE_RECORDS);
      onAll(
        [records.get([collection, item.id]), tx.objectStore(STORE_META).get(META_KEY)],
        fail,
        ([existing, meta]) => {
          const state = (meta as MetaRow | undefined) ?? this.newMeta();
          const ordinal = (existing as RecordRow | undefined)?.ordinal ?? state.nextOrdinal++;
          records.put({ collection, id: item.id, data: item, ordinal } satisfies RecordRow);
          tx.objectStore(STORE_VERSIONS).put({
            targetKey: targetKey({ kind: "record", collection, id: item.id }),
            version: mintVersion(state),
          } satisfies VersionRow);
          tx.objectStore(STORE_META).put(state);
          finish(item);
        },
      );
    });
  }

  async remove(collection: string, id: string): Promise<boolean> {
    assertCollectionName(collection);
    return this.run([STORE_RECORDS, STORE_VERSIONS], "readwrite", (tx, finish, fail) => {
      onResult(tx.objectStore(STORE_RECORDS).getKey([collection, id]), fail, (found) => {
        const existed = found !== undefined;
        if (existed) {
          tx.objectStore(STORE_RECORDS).delete([collection, id]);
          tx.objectStore(STORE_VERSIONS).delete(targetKey({ kind: "record", collection, id }));
        }
        finish(existed);
      });
    });
  }

  async count(collection: string, filter?: StoreFilter): Promise<number> {
    assertCollectionName(collection);
    const where = filter?.where;
    if (where) assertScalarWhere(where);
    return this.run([STORE_RECORDS], "readonly", (tx, finish, fail) => {
      const index = tx.objectStore(STORE_RECORDS).index(COLLECTION_INDEX);
      if (!where) {
        onResult(index.count(collection), fail, finish);
        return;
      }
      onResult<RecordRow[]>(index.getAll(collection), fail, (rows) => {
        finish(rows.filter((row) => matchesWhere(row.data, where)).length);
      });
    });
  }

  async getVersioned<T>(target: StoreTarget): Promise<VersionedStoreValue<T> | null> {
    if (target.kind === "record") assertCollectionName(target.collection);
    const valueStore = target.kind === "key" ? STORE_KV : STORE_RECORDS;
    return this.run([valueStore, STORE_VERSIONS], "readonly", (tx, finish, fail) => {
      onAll(
        [
          tx.objectStore(valueStore).get(valueKey(target)),
          tx.objectStore(STORE_VERSIONS).get(targetKey(target)),
        ],
        fail,
        ([valueRow, versionRow]) => {
          const observed = observedFrom(target, valueRow as KvRow | RecordRow | undefined, versionRow as VersionRow | undefined);
          finish(observed === null ? null : { value: observed.value as T, version: observed.version });
        },
      );
    });
  }

  async mutateAtomically(request: AtomicMutationRequest): Promise<AtomicMutationResult> {
    const validated = validateAtomicRequest(request, this.atomicLimits);
    const idempotencyKey = validated.idempotency?.key;
    return this.run(STORE_NAMES, "readwrite", (tx, finish, fail) => {
      const reads: IDBRequest[] = [tx.objectStore(STORE_META).get(META_KEY)];
      if (idempotencyKey !== undefined) reads.push(tx.objectStore(STORE_RECEIPTS).get(idempotencyKey));
      for (const condition of validated.conditions) {
        const valueStore = condition.target.kind === "key" ? STORE_KV : STORE_RECORDS;
        reads.push(
          tx.objectStore(valueStore).get(valueKey(condition.target)),
          tx.objectStore(STORE_VERSIONS).get(targetKey(condition.target)),
        );
      }
      for (const operation of validated.operations) {
        if (operation.op === "put") {
          reads.push(tx.objectStore(STORE_RECORDS).get([operation.collection, operation.item.id]));
        }
      }
      onAll(reads, fail, (results) => {
        const meta = results[0] as MetaRow | undefined;
        const receipt = idempotencyKey === undefined ? undefined : (results[1] as ReceiptRow | undefined);
        let cursor = idempotencyKey === undefined ? 1 : 2;

        if (receipt) {
          if (receipt.requestDigest !== validated.requestDigest) {
            finish({
              status: "idempotency-conflict",
              key: idempotencyKey!,
              expectedRequestDigest: receipt.requestDigest,
              receivedRequestDigest: validated.requestDigest,
            });
            return;
          }
          finish({
            status: "replayed",
            requestDigest: receipt.result.requestDigest,
            versions: receipt.result.versions,
            ...(receipt.result.outcome === undefined ? {} : { outcome: receipt.result.outcome }),
          });
          return;
        }

        for (const condition of validated.conditions) {
          const observed = observedFrom(
            condition.target,
            results[cursor] as KvRow | RecordRow | undefined,
            results[cursor + 1] as VersionRow | undefined,
          );
          cursor += 2;
          if (!conditionMatches(condition, observed)) {
            finish({
              status: "conflict",
              condition: cloneCondition(condition),
              observed: observed === null
                ? "missing"
                : condition.expected === "version"
                  ? observed.version
                  : "present",
            });
            return;
          }
        }

        const state = meta ?? this.newMeta();
        let metaDirty = false;
        const versions: { target: StoreTarget; version: StoreVersion | null }[] = [];
        for (const operation of validated.operations) {
          const target = operationTarget(operation);
          switch (operation.op) {
            case "set": {
              tx.objectStore(STORE_KV).put({ key: operation.key, value: cloneJson(operation.value) } satisfies KvRow);
              const version = mintVersion(state);
              tx.objectStore(STORE_VERSIONS).put({ targetKey: targetKey(target), version } satisfies VersionRow);
              versions.push({ target, version });
              metaDirty = true;
              break;
            }
            case "delete":
              tx.objectStore(STORE_KV).delete(operation.key);
              tx.objectStore(STORE_VERSIONS).delete(targetKey(target));
              versions.push({ target, version: null });
              break;
            case "put": {
              const existing = results[cursor++] as RecordRow | undefined;
              const ordinal = existing?.ordinal ?? state.nextOrdinal++;
              tx.objectStore(STORE_RECORDS).put({
                collection: operation.collection,
                id: operation.item.id,
                data: cloneJson(operation.item),
                ordinal,
              } satisfies RecordRow);
              const version = mintVersion(state);
              tx.objectStore(STORE_VERSIONS).put({ targetKey: targetKey(target), version } satisfies VersionRow);
              versions.push({ target, version });
              metaDirty = true;
              break;
            }
            case "remove":
              tx.objectStore(STORE_RECORDS).delete([operation.collection, operation.id]);
              tx.objectStore(STORE_VERSIONS).delete(targetKey(target));
              versions.push({ target, version: null });
              break;
          }
        }
        const applied: AtomicCompletedMutationResult & { status: "applied" } = {
          status: "applied",
          requestDigest: validated.requestDigest,
          versions,
          ...(validated.outcome === undefined ? {} : { outcome: cloneJson(validated.outcome) }),
        };
        if (metaDirty) tx.objectStore(STORE_META).put(state);
        if (idempotencyKey !== undefined) {
          tx.objectStore(STORE_RECEIPTS).put({
            key: idempotencyKey,
            requestDigest: validated.requestDigest,
            result: applied,
          } satisfies ReceiptRow);
        }
        finish(applied);
      });
    });
  }

  /** Run a synchronous reader against keys, records, and versions read in one
   *  readonly transaction. */
  async readTransaction<T>(reader: (view: IndexedDbReadView) => T): Promise<T> {
    const view = await this.run<IndexedDbReadView>(
      [STORE_KV, STORE_RECORDS, STORE_VERSIONS],
      "readonly",
      (tx, finish, fail) => {
        onAll(
          [
            tx.objectStore(STORE_KV).getAll(),
            tx.objectStore(STORE_RECORDS).getAll(),
            tx.objectStore(STORE_VERSIONS).getAll(),
          ],
          fail,
          ([kv, records, versions]) =>
            finish(makeReadView(kv as KvRow[], records as RecordRow[], versions as VersionRow[])),
        );
      },
    );
    return reader(view);
  }

  /** Export the whole database as a generic backup. */
  async exportState(): Promise<IndexedDbExport> {
    return this.run(STORE_NAMES, "readonly", (tx, finish, fail) => {
      onAll(
        [
          tx.objectStore(STORE_KV).getAll(),
          tx.objectStore(STORE_RECORDS).getAll(),
          tx.objectStore(STORE_VERSIONS).getAll(),
          tx.objectStore(STORE_RECEIPTS).getAll(),
          tx.objectStore(STORE_META).get(META_KEY),
        ],
        fail,
        ([kv, records, versions, receipts, meta]) => {
          const state = meta as MetaRow | undefined;
          finish({
            schemaVersion: 1,
            dbName: this.dbName,
            meta: state === undefined
              ? null
              : { versionIdentity: state.versionIdentity, nextVersion: state.nextVersion, nextOrdinal: state.nextOrdinal },
            kv: (kv as KvRow[]).sort((a, b) => compareCodePoints(a.key, b.key)),
            records: (records as RecordRow[]).sort((a, b) => a.ordinal - b.ordinal),
            versions: (versions as VersionRow[]).sort((a, b) => compareCodePoints(a.targetKey, b.targetKey)),
            receipts: (receipts as ReceiptRow[]).sort((a, b) => compareCodePoints(a.key, b.key)),
          });
        },
      );
    });
  }

  /** Replace the whole database with a generic backup, in one transaction. The
   *  backup is validated first, so a rejected backup leaves the database
   *  untouched. Keys or records without a version row are issued one. */
  async importState(state: IndexedDbImport): Promise<void> {
    validateIndexedDbExport(state);
    const have = new Set(state.versions.map((row) => row.targetKey));
    const unversioned: StoreTarget[] = [
      ...state.kv.map((row): StoreTarget => ({ kind: "key", key: row.key })),
      ...state.records.map((row): StoreTarget => ({ kind: "record", collection: row.collection, id: row.id })),
    ].filter((target) => !have.has(targetKey(target)));
    const imported = state.meta === null ? undefined : ({ name: META_KEY, ...state.meta } satisfies MetaRow);
    const backfill = backfillRows(imported, unversioned, this.versionIdentity);
    return this.run(STORE_NAMES, "readwrite", (tx, finish) => {
      for (const name of STORE_NAMES) tx.objectStore(name).clear();
      for (const row of state.kv) tx.objectStore(STORE_KV).put(row);
      for (const row of state.records) tx.objectStore(STORE_RECORDS).put(row);
      for (const row of [...state.versions, ...backfill.versions]) tx.objectStore(STORE_VERSIONS).put(row);
      for (const row of state.receipts) tx.objectStore(STORE_RECEIPTS).put(row);
      if (backfill.meta !== undefined) tx.objectStore(STORE_META).put(backfill.meta);
      finish(undefined);
    });
  }

  private newMeta(): MetaRow {
    return newMeta(this.versionIdentity);
  }

  private release(reason: IndexedDbConnectionError): void {
    this.unusable ??= reason;
    this.db.close();
  }

  private run<T>(
    stores: readonly IndexedDbStoreName[],
    mode: IDBTransactionMode,
    schedule: (tx: IDBTransaction, finish: (value: T) => void, fail: Fail) => void,
  ): Promise<T> {
    if (this.unusable) return Promise.reject(this.unusable);
    return new Promise<T>((resolve, reject) => {
      let tx: IDBTransaction;
      let finished = false;
      let settled = false;
      let requestError: unknown = null;
      const rejectOnce = (error: unknown) => {
        if (settled) return;
        settled = true;
        reject(toBackendError(error));
      };
      try {
        tx = this.db.transaction([...stores], mode);
      } catch (error) {
        rejectOnce(error);
        return;
      }
      let result!: T;
      const finish = (value: T) => {
        result = value;
        finished = true;
      };
      const fail = (error: unknown) => {
        rejectOnce(error);
        try {
          tx.abort();
        } catch {
          // A finished transaction cannot be aborted.
        }
      };
      tx.oncomplete = () => {
        if (settled) return;
        if (!finished) {
          rejectOnce(new Error("IndexedDB transaction completed without a result."));
          return;
        }
        settled = true;
        resolve(result);
      };
      tx.onerror = (event) => {
        const failed = (event.target as IDBRequest | null)?.error ?? tx.error;
        requestError ??= failed;
        rejectOnce(failed ?? new Error("IndexedDB transaction failed."));
      };
      tx.onabort = () => rejectOnce(tx.error ?? requestError ?? new Error("IndexedDB transaction aborted."));
      try {
        schedule(tx, finish, fail);
      } catch (error) {
        fail(error);
      }
    });
  }
}

function onResult<T>(request: IDBRequest, fail: Fail, handle: (value: T) => void): void {
  request.onsuccess = () => {
    try {
      handle(request.result as T);
    } catch (error) {
      fail(error);
    }
  };
}

function onAll(requests: readonly IDBRequest[], fail: Fail, handle: (values: unknown[]) => void): void {
  const values: unknown[] = new Array(requests.length);
  let pending = requests.length;
  requests.forEach((request, index) => {
    onResult(request, fail, (value) => {
      values[index] = value;
      pending -= 1;
      if (pending === 0) handle(values);
    });
  });
}

function randomIdentity(): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function newMeta(versionIdentity: string): MetaRow {
  return { name: META_KEY, versionIdentity, nextVersion: 1, nextOrdinal: 1 };
}

function mintVersion(state: MetaRow): StoreVersion {
  const version = `${state.versionIdentity}-v${state.nextVersion}` as StoreVersion;
  state.nextVersion += 1;
  return version;
}

/** Version rows for targets that have none, and the counters after issuing them. */
function backfillRows(
  meta: MetaRow | undefined,
  targets: readonly StoreTarget[],
  versionIdentity: string,
): { meta: MetaRow | undefined; versions: VersionRow[] } {
  if (targets.length === 0) return { meta, versions: [] };
  const state = meta === undefined ? newMeta(versionIdentity) : { ...meta };
  const versions = targets.map((target) => ({ targetKey: targetKey(target), version: mintVersion(state) }));
  return { meta: state, versions };
}

function backfillVersions(tx: IDBTransaction, versionIdentity: string): void {
  const fail: Fail = () => tx.abort();
  onAll(
    [
      tx.objectStore(STORE_META).get(META_KEY),
      tx.objectStore(STORE_VERSIONS).getAllKeys(),
      tx.objectStore(STORE_KV).getAllKeys(),
      tx.objectStore(STORE_RECORDS).getAllKeys(),
    ],
    fail,
    ([meta, versionKeys, kvKeys, recordKeys]) => {
      const have = new Set(versionKeys as string[]);
      // Schema v1 plain set() did not advance a key's version, so a v1 key
      // version row may name a token issued for an older value. Every key gets
      // a fresh version; records were versioned correctly in v1. v1 identities
      // came from a per-page counter shared across databases, so they are
      // replaced too.
      const targets: StoreTarget[] = [
        ...(kvKeys as string[]).map((key): StoreTarget => ({ kind: "key", key })),
        ...(recordKeys as [string, string][])
          .map(([collection, id]): StoreTarget => ({ kind: "record", collection, id }))
          .filter((target) => !have.has(targetKey(target))),
      ];
      const current = meta as MetaRow | undefined;
      const rekeyed =
        current !== undefined && /^idb\d+$/.test(current.versionIdentity)
          ? { ...current, versionIdentity }
          : current;
      const backfill = backfillRows(rekeyed, targets, versionIdentity);
      if (rekeyed !== current && backfill.versions.length === 0) tx.objectStore(STORE_META).put(rekeyed!);
      for (const row of backfill.versions) tx.objectStore(STORE_VERSIONS).put(row);
      if (backfill.versions.length > 0) tx.objectStore(STORE_META).put(backfill.meta!);
    },
  );
}

function ensureSchema(db: IDBDatabase, transaction: IDBTransaction): void {
  if (!db.objectStoreNames.contains(STORE_KV)) db.createObjectStore(STORE_KV, { keyPath: "key" });
  if (!db.objectStoreNames.contains(STORE_RECORDS)) {
    const records = db.createObjectStore(STORE_RECORDS, { keyPath: ["collection", "id"] });
    records.createIndex(COLLECTION_INDEX, "collection", { unique: false });
  } else {
    const records = transaction.objectStore(STORE_RECORDS);
    if (!records.indexNames.contains(COLLECTION_INDEX)) {
      records.createIndex(COLLECTION_INDEX, "collection", { unique: false });
    }
  }
  if (!db.objectStoreNames.contains(STORE_VERSIONS)) db.createObjectStore(STORE_VERSIONS, { keyPath: "targetKey" });
  if (!db.objectStoreNames.contains(STORE_RECEIPTS)) db.createObjectStore(STORE_RECEIPTS, { keyPath: "key" });
  if (!db.objectStoreNames.contains(STORE_META)) db.createObjectStore(STORE_META, { keyPath: "name" });
}

function assertCollectionName(collection: string): void {
  if (collection.length === 0) throw new Error("Invalid collection name");
}

/** Validate a complete generic backup before any destructive operation: row
 *  shapes, duplicate keys, version targets, counters, and cloneability. */
export function validateIndexedDbExport(value: unknown): asserts value is IndexedDbImport {
  if (!isPlainRecord(value) || value.schemaVersion !== 1) {
    throw new IndexedDbBackupError("unsupported-schema", "Unsupported IndexedDB export schema.");
  }
  if (
    !Array.isArray(value.kv) ||
    !Array.isArray(value.records) ||
    !Array.isArray(value.versions) ||
    !Array.isArray(value.receipts) ||
    !(value.meta === null || isPlainRecord(value.meta))
  ) {
    throw new IndexedDbBackupError("invalid-shape", "Invalid IndexedDB export arrays or metadata.");
  }
  if ("dbName" in value && value.dbName !== undefined && typeof value.dbName !== "string") {
    throw new IndexedDbBackupError("invalid-shape", "Invalid IndexedDB export database name.");
  }
  const kvKeys = new Set<string>();
  for (const row of value.kv) {
    if (!isPlainRecord(row) || typeof row.key !== "string") {
      throw new IndexedDbBackupError("invalid-row", "Invalid IndexedDB key row.");
    }
    if (kvKeys.has(row.key)) throw new IndexedDbBackupError("duplicate-row", "Duplicate IndexedDB key row.");
    kvKeys.add(row.key);
    assertCloneable(row.value, "IndexedDB key value");
  }
  const recordKeys = new Set<string>();
  let maxOrdinal = 0;
  for (const row of value.records) {
    if (
      !isPlainRecord(row) ||
      typeof row.collection !== "string" ||
      row.collection.length === 0 ||
      typeof row.id !== "string" ||
      !safePositiveInteger(row.ordinal)
    ) {
      throw new IndexedDbBackupError("invalid-row", "Invalid IndexedDB collection row.");
    }
    const key = `${row.collection}\u0000${row.id}`;
    if (recordKeys.has(key)) throw new IndexedDbBackupError("duplicate-row", "Duplicate IndexedDB collection row.");
    recordKeys.add(key);
    maxOrdinal = Math.max(maxOrdinal, row.ordinal);
    assertCloneable(row.data, "IndexedDB collection value");
  }
  const versionKeys = new Set<string>();
  let maxVersionNumber = 0;
  for (const row of value.versions) {
    if (!isPlainRecord(row) || typeof row.targetKey !== "string" || typeof row.version !== "string" || row.version.length === 0) {
      throw new IndexedDbBackupError("invalid-row", "Invalid IndexedDB version row.");
    }
    if (versionKeys.has(row.targetKey)) {
      throw new IndexedDbBackupError("duplicate-row", "Duplicate IndexedDB version row.");
    }
    if (!validTargetKey(row.targetKey)) {
      throw new IndexedDbBackupError("invalid-row", "Invalid IndexedDB version target.");
    }
    const targetExists = row.targetKey.startsWith("k:")
      ? kvKeys.has(decodeKeyTarget(row.targetKey) ?? "\u0000missing")
      : recordKeys.has(decodeRecordTarget(row.targetKey) ?? "\u0000missing");
    if (!targetExists) {
      throw new IndexedDbBackupError("dangling-version", "IndexedDB version row has no stored target.");
    }
    const versionNumber = versionCounter(row.version);
    if (versionNumber !== null) maxVersionNumber = Math.max(maxVersionNumber, versionNumber);
    versionKeys.add(row.targetKey);
  }
  if (value.meta === null && (value.records.length > 0 || value.versions.length > 0)) {
    throw new IndexedDbBackupError("invalid-metadata", "IndexedDB export is missing metadata for persisted records.");
  }
  if (value.meta !== null) {
    if (
      typeof value.meta.versionIdentity !== "string" ||
      value.meta.versionIdentity.length === 0 ||
      !safePositiveInteger(value.meta.nextVersion) ||
      !safePositiveInteger(value.meta.nextOrdinal) ||
      value.meta.nextOrdinal <= maxOrdinal ||
      value.meta.nextVersion <= maxVersionNumber
    ) {
      throw new IndexedDbBackupError("invalid-metadata", "Invalid IndexedDB metadata counters.");
    }
  }
  const receiptKeys = new Set<string>();
  for (const row of value.receipts) {
    if (
      !isPlainRecord(row) ||
      typeof row.key !== "string" ||
      typeof row.requestDigest !== "string" ||
      !/^[0-9a-f]{64}$/.test(row.requestDigest) ||
      !isPlainRecord(row.result) ||
      row.result.status !== "applied" ||
      row.result.requestDigest !== row.requestDigest ||
      !Array.isArray(row.result.versions)
    ) {
      throw new IndexedDbBackupError("invalid-row", "Invalid IndexedDB receipt row.");
    }
    if (receiptKeys.has(row.key)) throw new IndexedDbBackupError("duplicate-row", "Duplicate IndexedDB receipt row.");
    const resultTargets = new Set<string>();
    for (const entry of row.result.versions) {
      if (!isPlainRecord(entry) || !isStoreTarget(entry.target) || !(entry.version === null || (typeof entry.version === "string" && entry.version.length > 0))) {
        throw new IndexedDbBackupError("invalid-row", "Invalid IndexedDB receipt version.");
      }
      const key = targetKey(entry.target);
      if (resultTargets.has(key)) throw new IndexedDbBackupError("duplicate-row", "Duplicate IndexedDB receipt target.");
      resultTargets.add(key);
    }
    if ("outcome" in row.result) assertCloneable(row.result.outcome, "IndexedDB receipt outcome");
    try {
      canonicalJson(row.result);
    } catch {
      throw new IndexedDbBackupError("not-cloneable", "IndexedDB receipt result is not JSON-safe.");
    }
    receiptKeys.add(row.key);
    assertCloneable(row.result, "IndexedDB receipt result");
  }
}

function isPlainRecord(value: unknown): value is Record<string, any> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function safePositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

function assertCloneable(value: unknown, label: string): void {
  try {
    structuredClone(value);
  } catch {
    throw new IndexedDbBackupError("not-cloneable", `${label} is not structured-cloneable.`);
  }
}

function validTargetKey(value: string): boolean {
  return decodeKeyTarget(value) !== null || decodeRecordTarget(value) !== null;
}

function decodeKeyTarget(value: string): string | null {
  if (!value.startsWith("k:")) return null;
  const rest = value.slice(2);
  const separator = rest.indexOf(":");
  if (separator < 1) return null;
  const length = Number(rest.slice(0, separator));
  const key = rest.slice(separator + 1);
  return Number.isSafeInteger(length) && length === key.length ? key : null;
}

function decodeRecordTarget(value: string): string | null {
  if (!value.startsWith("r:")) return null;
  const rest = value.slice(2);
  const first = rest.indexOf(":");
  if (first < 1) return null;
  const collectionLength = Number(rest.slice(0, first));
  const collectionStart = first + 1;
  const second = rest.indexOf(":", collectionStart + collectionLength);
  if (second < collectionStart) return null;
  const collection = rest.slice(collectionStart, second);
  const idLengthEnd = rest.indexOf(":", second + 1);
  if (idLengthEnd < 0) return null;
  const idLength = Number(rest.slice(second + 1, idLengthEnd));
  const id = rest.slice(idLengthEnd + 1);
  return Number.isSafeInteger(collectionLength) && collectionLength === collection.length && Number.isSafeInteger(idLength) && idLength === id.length ? `${collection}\u0000${id}` : null;
}

function isStoreTarget(value: unknown): value is StoreTarget {
  if (!isPlainRecord(value) || (value.kind !== "key" && value.kind !== "record")) return false;
  return value.kind === "key"
    ? typeof value.key === "string"
    : typeof value.collection === "string" && value.collection.length > 0 && typeof value.id === "string";
}

function versionCounter(version: string): number | null {
  const marker = version.lastIndexOf("-v");
  if (marker < 1) return null;
  const counter = Number(version.slice(marker + 2));
  return safePositiveInteger(counter) ? counter : null;
}

function isJsonScalar(value: unknown): boolean {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  );
}

function assertScalarWhere(where: Record<string, unknown>): void {
  for (const value of Object.values(where)) {
    if (!isJsonScalar(value)) throw new StoreFilterError("non-scalar-filter", NON_SCALAR_FILTER_MESSAGE);
  }
}

function valueKey(target: StoreTarget): IDBValidKey {
  return target.kind === "key" ? target.key : [target.collection, target.id];
}

function operationTarget(operation: AtomicMutationRequest["operations"][number]): StoreTarget {
  switch (operation.op) {
    case "set":
    case "delete":
      return { kind: "key", key: operation.key };
    case "put":
      return { kind: "record", collection: operation.collection, id: operation.item.id };
    case "remove":
      return { kind: "record", collection: operation.collection, id: operation.id };
  }
}

/** Every stored key and record carries a version row, so a value row without
 *  one is treated as absent. */
function observedFrom(
  target: StoreTarget,
  valueRow: KvRow | RecordRow | undefined,
  versionRow: VersionRow | undefined,
): VersionedStoreValue<unknown> | null {
  if (valueRow === undefined || versionRow === undefined) return null;
  return {
    value: target.kind === "key" ? (valueRow as KvRow).value : (valueRow as RecordRow).data,
    version: versionRow.version as StoreVersion,
  };
}

function conditionMatches(condition: StoreCondition, observed: VersionedStoreValue<unknown> | null): boolean {
  if (condition.expected === "missing") return observed === null;
  if (condition.expected === "present") return observed !== null;
  return observed !== null && observed.version === condition.version;
}

function cloneCondition(condition: StoreCondition): StoreCondition {
  return condition.expected === "version"
    ? { target: { ...condition.target }, expected: "version", version: condition.version }
    : { target: { ...condition.target }, expected: condition.expected };
}

function matchesWhere(item: unknown, where: Record<string, unknown>): boolean {
  if (typeof item !== "object" || item === null) return false;
  const record = item as Record<string, unknown>;
  return Object.entries(where).every(([key, value]) => record[key] === value);
}

/** The reference store's filter semantics over one collection's rows. */
function applyFilter<T>(rows: readonly RecordRow[], filter?: StoreFilter): T[] {
  let items = rows
    .slice()
    .sort((a, b) => a.ordinal - b.ordinal)
    .map((row) => row.data);
  if (!filter) return items as T[];
  if (filter.where) {
    const where = filter.where;
    assertScalarWhere(where);
    items = items.filter((item) => matchesWhere(item, where));
  }
  if (filter.sortBy) {
    const field = filter.sortBy;
    const direction = filter.sortDir === "desc" ? -1 : 1;
    items = items.slice().sort((a, b) => {
      const av = fieldValue(a, field);
      const bv = fieldValue(b, field);
      const aMissing = av === undefined || av === null;
      const bMissing = bv === undefined || bv === null;
      if (aMissing && bMissing) return 0;
      if (aMissing) return 1;
      if (bMissing) return -1;
      if (av === bv) return 0;
      if (typeof av === "string" && typeof bv === "string") return compareCodePoints(av, bv) * direction;
      return ((av as number) < (bv as number) ? -1 : 1) * direction;
    });
  }
  if (filter.offset !== undefined && filter.offset > 0) {
    items = items.slice(Math.floor(filter.offset));
  }
  if (filter.limit !== undefined) {
    items = items.slice(0, Math.max(0, Math.floor(filter.limit)));
  }
  return items as T[];
}

function fieldValue(value: unknown, field: string): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  return (value as Record<string, unknown>)[field];
}

function makeReadView(kvRows: KvRow[], recordRows: RecordRow[], versionRows: VersionRow[]): IndexedDbReadView {
  const kv = new Map(kvRows.map((row) => [row.key, row]));
  const records = new Map(recordRows.map((row) => [targetKey({ kind: "record", collection: row.collection, id: row.id }), row]));
  const versions = new Map(versionRows.map((row) => [row.targetKey, row]));
  const valueRow = (target: StoreTarget) =>
    target.kind === "key" ? kv.get(target.key) : records.get(targetKey(target));
  return {
    get: <T>(key: string) => {
      const value = kv.get(key)?.value;
      return value === undefined ? null : (value as T);
    },
    has: (key: string) => kv.has(key),
    keys: (prefix?: string) =>
      [...kv.keys()].filter((key) => !prefix || key.startsWith(prefix)).sort(compareCodePoints),
    list: <T>(collection: string, filter?: StoreFilter) => {
      assertCollectionName(collection);
      if (filter?.where) assertScalarWhere(filter.where);
      return applyFilter<T>(recordRows.filter((row) => row.collection === collection), filter);
    },
    getById: <T>(collection: string, id: string) => {
      assertCollectionName(collection);
      const data = records.get(targetKey({ kind: "record", collection, id }))?.data;
      return data === undefined ? null : (data as T);
    },
    getVersioned: <T>(target: StoreTarget) => {
      if (target.kind === "record") assertCollectionName(target.collection);
      const observed = observedFrom(target, valueRow(target), versions.get(targetKey(target)));
      return observed === null ? null : { value: observed.value as T, version: observed.version };
    },
  };
}

function openError(error: unknown): Error {
  if (error instanceof IndexedDbConnectionError) return error;
  const name = errorName(error);
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (name === "VersionError") {
    return new IndexedDbConnectionError(
      "version-too-new",
      false,
      `IndexedDB database was created by a newer adapter${message ? `: ${message}` : "."}`,
    );
  }
  return new IndexedDbConnectionError("open-failed", true, `IndexedDB open failed${message ? `: ${message}` : "."}`);
}

function errorName(error: unknown): string {
  return typeof error === "object" && error !== null && "name" in error
    ? String((error as { name?: unknown }).name)
    : "";
}

function toBackendError(error: unknown): Error {
  if (
    error instanceof AtomicMutationBackendError ||
    error instanceof IndexedDbTransactionError ||
    error instanceof IndexedDbConnectionError ||
    error instanceof StoreFilterError
  ) {
    return error;
  }
  const name = errorName(error);
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (name === "AbortError") {
    return new IndexedDbTransactionError("aborted", true, `IndexedDB transaction aborted${message ? `: ${message}` : "."}`);
  }
  if (name === "QuotaExceededError") {
    return new IndexedDbTransactionError("quota-exceeded", false, `IndexedDB transaction exceeded available storage${message ? `: ${message}` : "."}`);
  }
  if (name === "DataCloneError") {
    return new AtomicMutationBackendError("serialization-failure", false, `IndexedDB transaction failed: ${message}`);
  }
  return new IndexedDbTransactionError("unknown", true, `IndexedDB transaction failed${message ? `: ${message}` : "."}`);
}
