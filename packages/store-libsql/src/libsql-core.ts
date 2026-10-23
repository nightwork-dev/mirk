// ─── @mirk/store-libsql adapter ──────────────────────────────────────────────
// One libSQL client, two async capability facets: `.kv` (AsyncStore and
// AsyncAtomicMutationStore) and `.vector` (AsyncVectorStore). Both ride the same
// connection, and the adapter implements AsyncStoreTransactions over it.
//
// Why facets and not "class implements AsyncStore, AsyncVectorStore": the two ports
// both declare get/remove/count with DIFFERENT shapes (kv `get(key)` vs vector
// `get(collection, id)`), so a single class can't implement both. One facet per
// capability is the collision-free shape — mirrors @mirk/store's SqliteAdapter.
//
// The async ports are implemented NATIVELY (every method awaits the client),
// NOT lifted from a sync impl via toAsync: libSQL is a network/file client whose
// every call is already a Promise.

import type { Client, InStatement, ResultSet, Transaction } from "@libsql/client";

import type {
  AfterCommitNotify,
  AsyncAtomicMutationStore,
  AsyncStore,
  AsyncStoreTransactions,
  AtomicCompletedMutationResult,
  AtomicMutationLimits,
  AtomicMutationRequest,
  AtomicMutationResult,
  StoreFilter,
  StoreMeta,
  StoreTarget,
  StoreVersion,
  VersionedStoreValue,
} from "@mirk/store";
import type {
  AsyncVectorStore,
  VectorStoreMeta,
  VectorDocument,
  VectorSearchResult,
  VectorSearchOptions,
  Vector,
} from "@mirk/store";
import {
  compareCodePoints,
  cosineSimilarity,
  bufferToVector,
  assertDimensions,
  isUsableVector,
  matchesWhere,
} from "@mirk/store";
import {
  AtomicMutationBackendError,
  AtomicMutationIndeterminateError,
  DEFAULT_ATOMIC_LIMITS,
  IN_PROCESS_ATOMIC_LIMITS,
  resolveAtomicLimits,
  validateAtomicRequest,
} from "@mirk/store/atomic";
import { AsyncTransactionCoordinator, TransactionScopeError } from "@mirk/store/transaction";
// Pure SQL-string builders shared with @mirk/store/sqlite — one definition so the
// two SQLite-dialect adapters can't drift in filter semantics.
import {
  buildWhereClause,
  buildOrderBy,
  buildLimitOffset,
  COLLECTION_TABLE_KIND,
  COLLECTION_TABLE_PREFIX,
  INSERT_REGISTERED_TABLE_SQL,
  INSERT_SCHEMA_VERSION_SQL,
  isSchemaVersionTooNew,
  isTableRegistryConflict,
  MIRK_REGISTRY_DDL,
  MIRK_SCHEMA_VERSION,
  schemaVersionTooNewMessage,
  SELECT_REGISTERED_TABLE_SQL,
  SELECT_SCHEMA_VERSION_SQL,
  SELECT_TABLE_CLAIM_SQL,
  SELECT_TABLE_EXISTS_SQL,
  tableResolution,
  type TableRegistryAnswer,
} from "@mirk/store/sql";

export type LibsqlAdapterErrorCode =
  | "unsupported-schema-version"
  | "invalid-collection-name"
  | "invalid-option"
  | "dimensions-changed"
  | "dimensions-unknown"
  | "adapter-closed"
  | "busy"
  | "transaction-expired"
  | "connection-lost"
  | "commit-indeterminate";

/** Thrown for invalid adapter input, incompatible on-disk state, and write
 *  transactions that could not run or finish. The codes for failed
 *  transactions are:
 *
 * - `busy`: the write lock was not acquired within `busyTimeoutMs`. Nothing
 *   was written.
 * - `transaction-expired`: the server ended the transaction, for example
 *   because it was held too long. Its writes were rolled back.
 * - `connection-lost`: the connection failed before the commit was sent. The
 *   transaction's writes were not committed.
 * - `commit-indeterminate`: the connection failed while the commit was in
 *   flight. The writes may or may not have committed; read durable state to
 *   find out.
 *
 * The driver's own error is the `cause`. */
export class LibsqlAdapterError extends Error {
  declare readonly name: "LibsqlAdapterError";
  readonly code: LibsqlAdapterErrorCode;

  constructor(code: LibsqlAdapterErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    Object.setPrototypeOf(this, new.target.prototype);
    this.code = code;
  }
}
Object.defineProperty(LibsqlAdapterError.prototype, "name", {
  value: "LibsqlAdapterError",
  writable: true,
  configurable: true,
  enumerable: false,
});

export interface LibsqlAdapterOptions {
  /** libSQL connection URL: `libsql://…` (remote/Turso), `file:./db.sqlite`, or `:memory:`. */
  url: string;
  /** Auth token for a remote (Turso) database. Ignored for file:/:memory:. */
  authToken?: string;
  /** Existing @libsql/client to reuse (shares one connection). When passed, the
   *  adapter never closes it on `close()` — ownership stays with the caller. */
  client?: Client;
  /** Embedding dimensions. Required to use the `.vector` facet; KV works without it. */
  dimensions?: number;
  /** Force the exact JS-cosine search path even when native vector search is
   *  available. Mainly for parity testing; production should leave this off. */
  forceJsCosine?: boolean;
  /** Prefix for every table the adapter creates, so several stores can share
   *  one database. Letters, digits and underscores, starting with a letter.
   *  Defaults to none, which reads and writes the same tables as
   *  `@mirk/store/sqlite`. */
  tablePrefix?: string;
  /** Override the atomic request bounds `.kv` enforces. Defaults to the
   *  in-process limits for a local database and the portable remote limits
   *  for a server. */
  atomicLimits?: Partial<AtomicMutationLimits>;
  /** The prefix version tokens carry when the database is first initialized.
   *  A database that already has one keeps it. Defaults to a fresh UUID. */
  versionIdentity?: string;
  /** How long, in milliseconds, a write waits for the database's write lock
   *  when the database reports it busy before failing with `busy`. Defaults
   *  to 30000. */
  busyTimeoutMs?: number;
  /** The clock, in milliseconds since the epoch, that stamps idempotency
   *  receipts. Defaults to `Date.now`. */
  now?: () => number;
}

export type LibsqlClientFactory = (config: {
  url: string;
  authToken?: string;
}) => Client;
export type LibsqlClient = Client;

type LibsqlKvStore = AsyncStore & AsyncAtomicMutationStore;

/** Multi-capability libSQL source adapter. The concrete entry point supplies the
 *  client factory so this shared core has no runtime dependency on a driver.
 *  Open once via the static `openWithFactory`; use `.kv` and/or `.vector` — both
 *  ride the same connection. */
export class LibsqlAdapterCore implements AsyncStoreTransactions {
  readonly kv: LibsqlKvStore;
  readonly vector: AsyncVectorStore;
  private readonly client: Client;
  private readonly ownsClient: boolean;
  private readonly database: LibsqlDatabase;

  protected constructor(client: Client, ownsClient: boolean, opts: LibsqlAdapterOptions) {
    this.client = client;
    this.ownsClient = ownsClient;
    const names = tableNames(opts.tablePrefix ?? "");
    this.database = new LibsqlDatabase(client, opts.url, opts.busyTimeoutMs ?? 30_000);
    const local = client.protocol === "file";
    this.kv = new LibsqlKvFacet(
      this.database,
      names,
      resolveAtomicLimits(opts.atomicLimits, local ? IN_PROCESS_ATOMIC_LIMITS : DEFAULT_ATOMIC_LIMITS),
      opts.now ?? Date.now,
    );
    this.vector = new LibsqlVectorFacet(this.database, names, opts.url, opts.dimensions, opts.forceJsCosine);
  }

  /** Run short, database-only work in one write transaction. Every `.kv` and
   *  `.vector` call inside `work` joins it; a nested call is a savepoint.
   *  Writers to the database run one at a time, so do network or other slow
   *  work before or after, never inside. A server may end a transaction that
   *  is held too long; it then fails with `transaction-expired`. */
  transaction<T>(work: () => T | Promise<T>): Promise<T> {
    return this.database.transactions.transaction(work);
  }

  afterCommit(notify: AfterCommitNotify): void {
    this.database.transactions.afterCommit(notify);
  }

  /** Close the underlying connection (shared by both facets). No-op for a client
   *  the caller passed in via `opts.client`. */
  close(): void {
    this.database.closed = true;
    if (this.ownsClient) this.client.close();
  }

  /** @internal Initialize the schema in one transaction. */
  async initialize(versionIdentity: string): Promise<void> {
    await this.transaction(async () => {
      await (this.kv as LibsqlKvFacet).init(versionIdentity);
      await (this.vector as LibsqlVectorFacet).init();
    });
  }
}

/** Internal driver binding used by the Node and web entry points. This stays in
 *  the unexported core module so consumers cannot bypass an entry point's URL
 *  policy or select a runtime client implementation directly. */
export async function openLibsqlAdapter<T extends LibsqlAdapterCore>(
  opts: LibsqlAdapterOptions,
  createClient: LibsqlClientFactory,
  construct: (client: Client, ownsClient: boolean, opts: LibsqlAdapterOptions) => T,
): Promise<T> {
  validateOptions(opts);
  const ownsClient = opts.client === undefined;
  const client =
    opts.client ??
    createClient(
      opts.authToken !== undefined
        ? { url: opts.url, authToken: opts.authToken }
        : { url: opts.url },
    );
  try {
    const adapter = construct(client, ownsClient, opts);
    await adapter.initialize(opts.versionIdentity ?? crypto.randomUUID());
    return adapter;
  } catch (err) {
    // A facet init can throw (e.g. dimension mismatch). Don't leak a client we
    // opened — but never close a client the caller passed in.
    if (ownsClient) {
      try {
        client.close();
      } catch {
        /* ignore */
      }
    }
    throw err;
  }
}

function validateOptions(opts: LibsqlAdapterOptions): void {
  if (opts.tablePrefix !== undefined && !/^[A-Za-z][A-Za-z0-9_]{0,47}$/.test(opts.tablePrefix)) {
    throw new LibsqlAdapterError(
      "invalid-option",
      "tablePrefix must start with a letter and contain at most 48 letters, digits and underscores.",
    );
  }
  const busy = opts.busyTimeoutMs;
  if (busy !== undefined && (!Number.isSafeInteger(busy) || busy < 0)) {
    throw new LibsqlAdapterError("invalid-option", "busyTimeoutMs must be a non-negative integer.");
  }
}

// ─── Table names ─────────────────────────────────────────────────────────────

interface TableNames {
  kv: string;
  registry: string;
  meta: string;
  versions: string;
  sequence: string;
  receipts: string;
  identity: string;
  vecMeta: string;
  vectors: string;
  vectorIndex: string;
  collectionPrefix: string;
  /** Rewrites a shared registry statement onto the prefixed registry tables. */
  registrySql(sql: string): string;
}

function tableNames(prefix: string): TableNames {
  const registry = `${prefix}_mirk_tables`;
  const meta = `${prefix}_mirk_meta`;
  return {
    kv: `${prefix}_kv`,
    registry,
    meta,
    versions: `${prefix}_mirk_atomic_versions`,
    sequence: `${prefix}_mirk_atomic_sequence`,
    receipts: `${prefix}_mirk_atomic_receipts`,
    identity: `${prefix}_mirk_atomic_identity`,
    vecMeta: `${prefix}_vec_meta`,
    vectors: `${prefix}vectors`,
    vectorIndex: `${prefix}vectors_vec_idx`,
    collectionPrefix: `${prefix}${COLLECTION_TABLE_PREFIX}`,
    registrySql: (sql) =>
      prefix === "" ? sql : sql.replaceAll("_mirk_tables", registry).replaceAll("_mirk_meta", meta),
  };
}

// ─── Connection and transactions ─────────────────────────────────────────────

/** The open write transaction. `minted` is the highest version number it has
 *  issued, so a rollback can keep the sequence past it. */
interface OpenTransaction {
  execute(stmt: InStatement): Promise<ResultSet>;
  batch(stmts: InStatement[]): Promise<ResultSet[]>;
  minted: number;
  /** Remote: the client's transaction stream. Local: undefined. */
  readonly stream: Transaction | undefined;
  /** Local: releases the adapter's connection. */
  readonly release: (() => void) | undefined;
  /** Set once COMMIT or ROLLBACK starts; later calls wait for `finished`. */
  ending: boolean;
  readonly finished: Promise<void>;
  readonly finish: () => void;
}

function openTransaction(
  fields: Pick<OpenTransaction, "execute" | "batch" | "minted" | "stream" | "release">,
): OpenTransaction {
  let finish!: () => void;
  const finished = new Promise<void>((resolve) => (finish = resolve));
  return { ...fields, ending: false, finished, finish };
}

/** A store call that reaches a transaction after its work returned waits for
 *  the transaction to end, then fails the way a call after the end does. */
async function usable(open: OpenTransaction): Promise<void> {
  if (!open.ending) return;
  await open.finished;
  throw new TransactionScopeError(
    "transaction-ended",
    "The transaction has ended; await every store call inside transaction().",
  );
}

const OUTER_SAVEPOINT = "mirk_outer";

/** A first-come, first-served async lock. */
class Mutex {
  private tail: Promise<void> = Promise.resolve();

  acquire(): Promise<() => void> {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const acquired = this.tail.then(() => release);
    this.tail = this.tail.then(() => held);
    return acquired;
  }
}

const localWriters = new Map<string, Mutex>();

/** The writer lock shared by every adapter in this process on the database
 *  file `url` names. URLs that spell one file differently get separate locks
 *  and fall back to SQLite's busy handling. In-memory databases are private to
 *  their connection, so each gets its own. */
function fileWriters(url: string): Mutex {
  const path = url.replace(/^file:/i, "").replace(/\?.*$/, "");
  if (!/^file:/i.test(url) || path === "" || path === ":memory:" || /[?&]mode=memory\b/.test(url)) {
    return new Mutex();
  }
  let writers = localWriters.get(path);
  if (!writers) {
    writers = new Mutex();
    localWriters.set(path, writers);
  }
  return writers;
}

/**
 * Runs statements on the adapter's client, inside the calling context's open
 * transaction when there is one.
 *
 * A remote client gives each write transaction its own stream; the server
 * serializes writers with `BEGIN IMMEDIATE`. A local (`file:`/`:memory:`)
 * client has one connection, so the adapter queues its calls behind its open
 * transaction and issues `BEGIN IMMEDIATE` on that connection. Adapters in one
 * process take turns on a file before they begin, so only another process can
 * find the file locked; the adapter then retries until `busyTimeoutMs`.
 *
 * Every outermost transaction opens with a savepoint. Rolling back returns to
 * it and commits only the version sequence, so a token issued inside the
 * rolled-back work is never issued again.
 */
class LibsqlDatabase {
  readonly transactions: AsyncTransactionCoordinator<OpenTransaction>;
  readonly local: boolean;
  closed = false;
  /** Version numbers issued by a transaction whose rollback could not be
   *  confirmed; the next transaction moves the sequence past them. */
  private floor = 0;
  /** Local: this adapter's one connection. */
  private readonly connection = new Mutex();
  /** Local: the writers of this file in this process. */
  private readonly writers: Mutex;
  /** Local: a statement on the connection failed busy. libSQL keeps such a
   *  statement active until it is garbage collected, and SQLite refuses a
   *  savepoint while it is, so the next transaction starts on a new
   *  connection. */
  private stale = false;
  sequenceTable = "";

  constructor(
    private readonly client: Client,
    url: string,
    private readonly busyTimeoutMs: number,
  ) {
    this.local = client.protocol === "file";
    this.writers = this.local ? fileWriters(url) : this.connection;
    this.transactions = new AsyncTransactionCoordinator<OpenTransaction>({
      begin: () => this.begin(),
      commit: async (open) => {
        await this.commitOpen(open);
        if (this.floor <= open.minted) this.floor = 0;
      },
      rollback: (open) => this.rollbackOpen(open),
      savepoint: async (open, name) => {
        await usable(open);
        await guard(open.execute(`SAVEPOINT ${name}`));
      },
      releaseSavepoint: async (open, name) => {
        await guard(open.execute(`RELEASE SAVEPOINT ${name}`));
      },
      rollbackToSavepoint: async (open, name) => {
        await guard(open.batch([`ROLLBACK TO SAVEPOINT ${name}`, ...this.keepMinted(open)]));
      },
      end: async (open, cleanupError) => {
        if (cleanupError !== undefined) this.floor = Math.max(this.floor, open.minted);
        try {
          if (open.stream) {
            open.stream.close();
          } else {
            if (cleanupError !== undefined) {
              await this.client.execute("ROLLBACK").catch(() => undefined);
              this.stale = true;
            }
            open.release!();
          }
        } finally {
          open.finish();
        }
      },
    });
  }

  /** Run a statement in the calling context's transaction, or on its own. */
  execute(stmt: InStatement): Promise<ResultSet> {
    return this.transactions.withConnection(async (open) => {
      if (!open) return this.alone(() => this.client.execute(stmt));
      await usable(open);
      return guard(open.execute(stmt));
    });
  }

  /** Run `op` with the open transaction. The caller must be inside one. */
  inTransaction<T>(op: (open: OpenTransaction) => Promise<T>): Promise<T> {
    return this.transactions.withConnection(async (open) => {
      if (!open) throw new Error("internal: a libSQL write ran outside its transaction");
      await usable(open);
      return op(open);
    });
  }

  private async alone<T>(op: () => Promise<T>): Promise<T> {
    if (!this.local) return guard(op());
    const release = await this.connection.acquire();
    try {
      await this.replaceConnection();
      return await guard(op());
    } finally {
      release();
    }
  }

  /** Move the client onto a new connection. Starting a deferred transaction
   *  hands the current connection to it and makes the client open another. */
  private async replaceConnection(): Promise<void> {
    if (!this.stale) return;
    const handoff = await this.client.transaction("deferred");
    this.stale = false;
    try {
      handoff.close();
    } catch {
      // The old connection is abandoned either way; it holds no lock.
    }
  }

  private keepMinted(open: OpenTransaction): InStatement[] {
    return open.minted > 0
      ? [{
          sql: `UPDATE ${this.sequenceTable} SET value = max(value, ?) WHERE id = 1`,
          args: [open.minted],
        }]
      : [];
  }

  private async begin(): Promise<OpenTransaction> {
    if (this.closed) throw new LibsqlAdapterError("adapter-closed", "The libSQL adapter is closed.");
    const minted = this.floor;
    const opening: InStatement[] = [`SAVEPOINT ${OUTER_SAVEPOINT}`];
    if (minted > 0 && this.sequenceTable !== "") {
      opening.push({
        sql: `UPDATE ${this.sequenceTable} SET value = max(value, ?) WHERE id = 1`,
        args: [minted],
      });
    }
    if (this.local) {
      const releaseWriters = await this.writers.acquire();
      const releaseConnection = this.writers === this.connection ? () => undefined : await this.connection.acquire();
      const release = () => {
        releaseConnection();
        releaseWriters();
      };
      try {
        await this.whileBusy(async () => {
          await this.replaceConnection();
          try {
            await this.client.execute("BEGIN IMMEDIATE");
          } catch (error) {
            if (classifyFailure(error) === "busy") {
              this.stale = true;
              await this.replaceConnection();
            }
            throw error;
          }
        });
        const open = openTransaction({
          execute: (stmt) => this.client.execute(stmt),
          batch: async (stmts) => {
            const results: ResultSet[] = [];
            for (const stmt of stmts) results.push(await this.client.execute(stmt));
            return results;
          },
          minted,
          stream: undefined,
          release,
        });
        try {
          await guard(open.batch(opening));
        } catch (error) {
          await this.client.execute("ROLLBACK").catch(() => undefined);
          throw error;
        }
        return open;
      } catch (error) {
        release();
        throw error;
      }
    }
    return this.whileBusy(async () => {
      const stream = await this.client.transaction("write");
      try {
        // The client sends BEGIN IMMEDIATE with the first statement; the server
        // holds it until no other transaction has the write lock.
        await stream.batch(opening);
      } catch (error) {
        stream.close();
        throw error;
      }
      return openTransaction({
        execute: (stmt) => stream.execute(stmt),
        batch: (stmts) => stream.batch(stmts),
        minted,
        stream,
        release: undefined,
      });
    });
  }

  private async commitOpen(open: OpenTransaction): Promise<void> {
    open.ending = true;
    try {
      if (open.stream) await open.stream.commit();
      else await this.whileBusy(() => this.client.execute("COMMIT"));
    } catch (error) {
      if (error instanceof LibsqlAdapterError) throw error;
      const code = classifyFailure(error);
      if (code === undefined) throw error;
      throw failure(code === "connection-lost" ? "commit-indeterminate" : code, error);
    }
  }

  private async rollbackOpen(open: OpenTransaction): Promise<void> {
    open.ending = true;
    if (open.minted === 0) {
      if (open.stream) await guard(open.stream.rollback());
      else await guard(this.client.execute("ROLLBACK"));
      return;
    }
    await guard(open.batch([`ROLLBACK TO SAVEPOINT ${OUTER_SAVEPOINT}`, ...this.keepMinted(open)]));
    await this.commitOpen(open);
    if (this.floor <= open.minted) this.floor = 0;
  }

  /** Retry `attempt` while the database reports its write lock busy. */
  private async whileBusy<T>(attempt: () => Promise<T>): Promise<T> {
    const started = Date.now();
    for (let tries = 0; ; tries++) {
      try {
        return await attempt();
      } catch (error) {
        const code = classifyFailure(error);
        if (code !== "busy") throw code === undefined ? error : failure(code, error);
        if (this.local) this.stale = true;
        if (Date.now() - started >= this.busyTimeoutMs) throw failure("busy", error);
        await new Promise((resolve) => setTimeout(resolve, Math.min(2 ** tries, 50)));
      }
    }
  }
}

type FailureCode = "busy" | "transaction-expired" | "connection-lost";

const FAILURE_MESSAGES: Record<FailureCode | "commit-indeterminate", string> = {
  "busy": "The libSQL database stayed locked by another writer for longer than busyTimeoutMs.",
  "transaction-expired": "The libSQL server ended the transaction; its writes were rolled back.",
  "connection-lost": "The libSQL connection failed before the transaction committed.",
  "commit-indeterminate": "The libSQL connection failed during COMMIT; the transaction may or may not have committed.",
};

function failure(code: FailureCode | "commit-indeterminate", cause: unknown): LibsqlAdapterError {
  return new LibsqlAdapterError(code, FAILURE_MESSAGES[code], { cause });
}

/** Rethrow driver failures that end a transaction as typed adapter errors;
 *  SQL errors pass through unchanged. */
async function guard<T>(promise: Promise<T>): Promise<T> {
  try {
    return await promise;
  } catch (error) {
    if (error instanceof LibsqlAdapterError) throw error;
    const code = classifyFailure(error);
    throw code === undefined ? error : failure(code, error);
  }
}

const TRANSPORT_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "EPIPE",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EAI_AGAIN",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_CLOSED",
  "HRANA_WEBSOCKET_ERROR",
  "HRANA_CLOSED_ERROR",
]);

/** Classifies a driver error by its code and message only, so this module
 *  stays free of a runtime dependency on a particular libSQL client. */
function classifyFailure(error: unknown): FailureCode | undefined {
  for (let current = error, depth = 0; current !== undefined && current !== null && depth < 5; depth++) {
    if (typeof current !== "object") return undefined;
    const { code, rawCode, message, name } = current as {
      code?: unknown;
      rawCode?: unknown;
      message?: unknown;
      name?: unknown;
    };
    const text = typeof message === "string" ? message : "";
    if (/transaction was rolled back|stream was idle/.test(text)) return "transaction-expired";
    if (code === "SQLITE_BUSY" || rawCode === 5 || /SQLITE_BUSY|database is locked/.test(text)) return "busy";
    if (
      code === "TRANSACTION_TIMEOUT" ||
      code === "STREAM_EXPIRED" ||
      code === "TRANSACTION_CLOSED" ||
      (code === "SERVER_ERROR" && /HTTP status 404\b/.test(text))
    ) {
      return "transaction-expired";
    }
    if (
      (typeof code === "string" && TRANSPORT_CODES.has(code)) ||
      code === "SERVER_ERROR" ||
      name === "AbortError" ||
      name === "TimeoutError" ||
      (name === "TypeError" && text === "fetch failed")
    ) {
      return "connection-lost";
    }
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

// ─── Schema bootstrap ────────────────────────────────────────────────────────

interface Executor {
  execute(stmt: InStatement): Promise<ResultSet>;
}

/** Create `_mirk_tables` / `_mirk_meta` and pin `schema_version`, refusing a
 *  file written by a newer adapter. Same procedure as @mirk/store/sqlite: the
 *  two adapters read and write each other's files. */
async function ensureMirkRegistry(db: Executor, names: TableNames): Promise<void> {
  const meta = await db.execute({
    sql: "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
    args: [names.meta],
  });
  if (meta.rows.length > 0) {
    const rs = await db.execute(names.registrySql(SELECT_SCHEMA_VERSION_SQL));
    const found = rs.rows[0]?.value as string | undefined;
    if (found !== undefined && isSchemaVersionTooNew(found)) {
      throw new LibsqlAdapterError("unsupported-schema-version", schemaVersionTooNewMessage(found, MIRK_SCHEMA_VERSION));
    }
  }
  // `execute` is one statement per call; the shared DDL holds two.
  for (const statement of names.registrySql(MIRK_REGISTRY_DDL).split(";")) {
    if (statement.trim().length > 0) await db.execute(statement);
  }
  await db.execute({
    sql: names.registrySql(INSERT_SCHEMA_VERSION_SQL),
    args: [String(MIRK_SCHEMA_VERSION)],
  });
}

/** Async driver for the shared `tableResolution` procedure in @mirk/store/sql —
 *  the same three steps @mirk/store/sqlite runs synchronously. */
async function runTableResolution(
  db: LibsqlDatabase,
  names: TableNames,
  kind: string,
  name: string,
  register: boolean,
): Promise<string> {
  // A concurrent opener can claim the candidate between this resolution's
  // lookup and its INSERT. Restarting reads the winner's row as a registry hit.
  for (let attempt = 1; ; attempt++) {
    try {
      return await db.transactions.transaction(() => resolveTableOnce(db, names, kind, name, register));
    } catch (err) {
      if (attempt >= TABLE_RESOLUTION_ATTEMPTS || !isTableRegistryConflict(err)) {
        throw err;
      }
    }
  }
}

const TABLE_RESOLUTION_ATTEMPTS = 5;

async function resolveTableOnce(
  db: Executor,
  names: TableNames,
  kind: string,
  name: string,
  register: boolean,
): Promise<string> {
  const resolution = tableResolution(kind, name, names.collectionPrefix, register);
  let step = resolution.next();
  while (!step.done) {
    const query = step.value;
    let answer: TableRegistryAnswer;
    if (query.q === "registered") {
      const rs = await db.execute({
        sql: names.registrySql(SELECT_REGISTERED_TABLE_SQL),
        args: [query.kind, query.name],
      });
      answer = rs.rows[0]?.table_name as string | undefined;
    } else if (query.q === "claimant") {
      const rs = await db.execute({
        sql: names.registrySql(SELECT_TABLE_CLAIM_SQL),
        args: [query.table],
      });
      answer = rs.rows[0]?.name as string | undefined;
    } else if (query.q === "tableExists") {
      const rs = await db.execute({
        sql: SELECT_TABLE_EXISTS_SQL,
        args: [query.table],
      });
      answer = rs.rows.length > 0;
    } else {
      await db.execute({
        sql: names.registrySql(INSERT_REGISTERED_TABLE_SQL),
        args: [query.kind, query.name, query.table],
      });
    }
    step = resolution.next(answer);
  }
  return step.value;
}

// ─── KV facet (AsyncStore + AsyncAtomicMutationStore) ────────────────────────

type VersionKey = [kind: string, collection: string, key: string];

function versionKey(target: StoreTarget): VersionKey {
  return target.kind === "key" ? ["key", "", target.key] : ["record", target.collection, target.id];
}

class LibsqlKvFacet implements LibsqlKvStore {
  readonly meta: StoreMeta = { backend: "libsql" };
  private readonly initializedTables = new Map<string, string>();
  private versionPrefix = "";

  constructor(
    private readonly db: LibsqlDatabase,
    private readonly names: TableNames,
    readonly atomicLimits: AtomicMutationLimits,
    private readonly now: () => number,
  ) {}

  /** Runs inside the adapter's opening transaction. */
  async init(versionIdentity: string): Promise<void> {
    const n = this.names;
    await ensureMirkRegistry(this.db, n);
    await this.db.execute(`
      CREATE TABLE IF NOT EXISTS ${n.kv} (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      )
    `);
    // The same tables, in the same shape, as @mirk/store/sqlite's atomic store.
    await this.db.execute(`
      CREATE TABLE IF NOT EXISTS ${n.versions} (
        kind TEXT NOT NULL,
        collection TEXT NOT NULL,
        target_key TEXT NOT NULL,
        version TEXT NOT NULL,
        PRIMARY KEY (kind, collection, target_key)
      )
    `);
    await this.db.execute(`
      CREATE TABLE IF NOT EXISTS ${n.sequence} (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        value INTEGER NOT NULL
      )
    `);
    await this.db.execute(`INSERT OR IGNORE INTO ${n.sequence} (id, value) VALUES (1, 0)`);
    await this.db.execute(`
      CREATE TABLE IF NOT EXISTS ${n.receipts} (
        idempotency_key TEXT PRIMARY KEY,
        request_digest TEXT NOT NULL,
        result_json TEXT NOT NULL,
        created_at INTEGER
      )
    `);
    // Receipts written by @mirk/store/sqlite or an earlier release carry no
    // creation time.
    const receiptColumns = await this.db.execute(`PRAGMA table_info(${n.receipts})`);
    if (!receiptColumns.rows.some((row) => row.name === "created_at")) {
      await this.db.execute(`ALTER TABLE ${n.receipts} ADD COLUMN created_at INTEGER`);
    }
    await this.db.execute(`
      CREATE TABLE IF NOT EXISTS ${n.identity} (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        value TEXT NOT NULL
      )
    `);
    await this.db.execute({
      sql: `INSERT OR IGNORE INTO ${n.identity} (id, value) VALUES (1, ?)`,
      args: [versionIdentity],
    });
    const identity = await this.db.execute(`SELECT value FROM ${n.identity} WHERE id = 1`);
    this.versionPrefix = identity.rows[0]!.value as string;
    this.db.sequenceTable = n.sequence;
  }

  /** Physical table for a collection, via the `_mirk_tables` registry, created
   *  if missing. The hash-derived name is only the first CANDIDATE: a name whose
   *  candidate is already claimed by a different collection gets `_2`, `_3`, …
   *  so two names that sanitize and hash alike never share one table. The
   *  table is remembered only once the transaction that created it commits. */
  private async ensureTable(collection: string): Promise<string> {
    if (collection.length === 0) throw new LibsqlAdapterError("invalid-collection-name", "Invalid collection name");
    const cached = this.initializedTables.get(collection);
    if (cached !== undefined) return cached;
    return this.write(async () => {
      const table = await runTableResolution(this.db, this.names, COLLECTION_TABLE_KIND, collection, true);
      await this.db.execute(
        `CREATE TABLE IF NOT EXISTS ${table} (
          id TEXT PRIMARY KEY,
          data TEXT NOT NULL,
          created_at TEXT DEFAULT (datetime('now')),
          updated_at TEXT DEFAULT (datetime('now'))
        )`,
      );
      this.db.transactions.afterCommit(() => this.initializedTables.set(collection, table));
      return table;
    });
  }

  /** Every write runs in a write transaction: its own, or a savepoint of the
   *  caller's, so the data and its version token change together. */
  private write<T>(work: () => Promise<T>): Promise<T> {
    return this.db.transactions.transaction(work);
  }

  async get<T>(key: string): Promise<T | null> {
    const rs = await this.db.execute({
      sql: `SELECT value FROM ${this.names.kv} WHERE key = ?`,
      args: [key],
    });
    const row = rs.rows[0];
    if (!row) return null;
    return JSON.parse(row.value as string) as T;
  }

  async set<T>(key: string, value: T): Promise<void> {
    const encoded = JSON.stringify(value);
    await this.write(() => this.writeKey(key, encoded));
  }

  async has(key: string): Promise<boolean> {
    const rs = await this.db.execute({
      sql: `SELECT 1 FROM ${this.names.kv} WHERE key = ?`,
      args: [key],
    });
    return rs.rows.length > 0;
  }

  async delete(key: string): Promise<boolean> {
    return this.write(() => this.deleteKey(key));
  }

  async keys(prefix?: string): Promise<string[]> {
    if (prefix) {
      // Escape LIKE wildcards so the prefix matches LITERALLY (startsWith), not as
      // a pattern — matches the in-memory reference's `key.startsWith(prefix)`.
      const escaped = prefix.replace(/[\\%_]/g, (c) => `\\${c}`);
      const rs = await this.db.execute({
        sql: `SELECT key FROM ${this.names.kv} WHERE key LIKE ? ESCAPE '\\' ORDER BY key`,
        args: [`${escaped}%`],
      });
      return rs.rows.map((r) => r.key as string);
    }
    const rs = await this.db.execute(`SELECT key FROM ${this.names.kv} ORDER BY key`);
    return rs.rows.map((r) => r.key as string);
  }

  async list<T>(collection: string, filter?: StoreFilter): Promise<T[]> {
    const table = await this.ensureTable(collection);
    const where = buildWhereClause(filter);
    const orderBy = buildOrderBy(filter);
    const limitOffset = buildLimitOffset(filter);
    const sql = `SELECT data FROM ${table}${where.clause}${orderBy.clause}${limitOffset}`;
    const rs = await this.db.execute({
      sql,
      args: [...where.params, ...orderBy.params],
    });
    return rs.rows.map((r) => JSON.parse(r.data as string) as T);
  }

  async getById<T>(collection: string, id: string): Promise<T | null> {
    const table = await this.ensureTable(collection);
    const rs = await this.db.execute({
      sql: `SELECT data FROM ${table} WHERE id = ?`,
      args: [id],
    });
    const row = rs.rows[0];
    if (!row) return null;
    return JSON.parse(row.data as string) as T;
  }

  async put<T extends { id: string }>(collection: string, item: T): Promise<T> {
    const encoded = JSON.stringify(item);
    await this.write(() => this.writeRecord(collection, item.id, encoded));
    return item;
  }

  async remove(collection: string, id: string): Promise<boolean> {
    return this.write(() => this.deleteRecord(collection, id));
  }

  async count(collection: string, filter?: StoreFilter): Promise<number> {
    const table = await this.ensureTable(collection);
    const where = buildWhereClause(filter);
    const rs = await this.db.execute({
      sql: `SELECT COUNT(*) as cnt FROM ${table}${where.clause}`,
      args: where.params,
    });
    // bigint-safe: libSQL may return integer columns as bigint.
    return Number(rs.rows[0]!.cnt);
  }

  async getVersioned<T>(target: StoreTarget): Promise<VersionedStoreValue<T> | null> {
    const row = await this.readVersioned(target);
    if (!row) return null;
    // A row written before this adapter issued version tokens gets one now.
    const version = row.version ?? (await this.write(() => this.backfillVersion(target)));
    return version === null ? null : { value: JSON.parse(row.value) as T, version };
  }

  async mutateAtomically(request: AtomicMutationRequest): Promise<AtomicMutationResult> {
    const validated = validateAtomicRequest(request, this.atomicLimits);
    const outermost = !this.db.transactions.inTransaction();
    try {
      return await this.write(() => this.decideAtomic(validated));
    } catch (error) {
      // Inside a caller's transaction nothing has committed yet; the caller's
      // transaction reports the failure.
      if (!outermost || !(error instanceof LibsqlAdapterError)) throw error;
      if (error.code === "commit-indeterminate") {
        const key = validated.idempotency?.key;
        throw new AtomicMutationIndeterminateError(
          validated.requestDigest,
          key,
          key === undefined ? "manual-reconciliation" : "retry-with-same-key",
        );
      }
      if (error.code === "busy" || error.code === "connection-lost" || error.code === "transaction-expired") {
        throw new AtomicMutationBackendError("unavailable", true, error.message);
      }
      throw error;
    }
  }

  private async decideAtomic(validated: ReturnType<typeof validateAtomicRequest>): Promise<AtomicMutationResult> {
    const key = validated.idempotency?.key;
    if (key !== undefined) {
      const prior = await this.readReceipt(key);
      if (prior) {
        const priorDigest = prior.requestDigest;
        if (priorDigest !== validated.requestDigest) {
          return {
            status: "idempotency-conflict",
            key,
            expectedRequestDigest: priorDigest,
            receivedRequestDigest: validated.requestDigest,
          };
        }
        const result = prior.result;
        return {
          status: "replayed",
          requestDigest: result.requestDigest,
          versions: result.versions,
          ...(result.outcome === undefined ? {} : { outcome: result.outcome }),
        };
      }
    }

    for (const condition of validated.conditions) {
      const observed = await this.getVersioned(condition.target);
      const matches = condition.expected === "missing"
        ? observed === null
        : condition.expected === "present"
          ? observed !== null
          : observed?.version === condition.version;
      if (!matches) {
        return {
          status: "conflict",
          condition,
          observed: observed === null ? "missing" : condition.expected === "version" ? observed.version : "present",
        };
      }
    }

    const versions: { target: StoreTarget; version: StoreVersion | null }[] = [];
    for (const operation of validated.operations) {
      switch (operation.op) {
        case "set":
          versions.push({
            target: { kind: "key", key: operation.key },
            version: await this.writeKey(operation.key, JSON.stringify(operation.value)),
          });
          break;
        case "delete":
          await this.deleteKey(operation.key);
          versions.push({ target: { kind: "key", key: operation.key }, version: null });
          break;
        case "put":
          versions.push({
            target: { kind: "record", collection: operation.collection, id: operation.item.id },
            version: await this.writeRecord(operation.collection, operation.item.id, JSON.stringify(operation.item)),
          });
          break;
        case "remove":
          await this.deleteRecord(operation.collection, operation.id);
          versions.push({ target: { kind: "record", collection: operation.collection, id: operation.id }, version: null });
          break;
      }
    }
    const applied: AtomicCompletedMutationResult = {
      status: "applied",
      requestDigest: validated.requestDigest,
      versions,
      ...(validated.outcome === undefined ? {} : { outcome: validated.outcome }),
    };
    if (key !== undefined) await this.writeReceipt(key, validated.requestDigest, applied);
    return applied;
  }

  // ─── Idempotency receipts ──────────────────────────────────────────────────
  // Every receipt read and write goes through these two methods.

  private async readReceipt(
    key: string,
  ): Promise<{ requestDigest: string; result: AtomicCompletedMutationResult; createdAt: number | null } | null> {
    const row = (
      await this.db.execute({
        sql: `SELECT request_digest, result_json, created_at FROM ${this.names.receipts} WHERE idempotency_key = ?`,
        args: [key],
      })
    ).rows[0];
    if (!row) return null;
    return {
      requestDigest: row.request_digest as string,
      result: JSON.parse(row.result_json as string) as AtomicCompletedMutationResult,
      createdAt: row.created_at === null || row.created_at === undefined ? null : Number(row.created_at),
    };
  }

  private async writeReceipt(key: string, requestDigest: string, result: AtomicCompletedMutationResult): Promise<void> {
    await this.db.execute({
      sql: `INSERT INTO ${this.names.receipts} (idempotency_key, request_digest, result_json, created_at) VALUES (?, ?, ?, ?)`,
      args: [key, requestDigest, JSON.stringify(result), this.now()],
    });
  }

  private async readVersioned(target: StoreTarget): Promise<{ value: string; version: StoreVersion | null } | null> {
    const n = this.names;
    let rs: ResultSet;
    if (target.kind === "key") {
      rs = await this.db.execute({
        sql: `SELECT k.value AS value, v.version AS version
              FROM ${n.kv} AS k
              LEFT JOIN ${n.versions} AS v
                ON v.kind = 'key' AND v.collection = '' AND v.target_key = k.key
              WHERE k.key = ?`,
        args: [target.key],
      });
    } else {
      const table = await this.ensureTable(target.collection);
      rs = await this.db.execute({
        sql: `SELECT c.data AS value, v.version AS version
              FROM ${table} AS c
              LEFT JOIN ${n.versions} AS v
                ON v.kind = 'record' AND v.collection = ? AND v.target_key = c.id
              WHERE c.id = ?`,
        args: [target.collection, target.id],
      });
    }
    const row = rs.rows[0];
    if (!row) return null;
    return {
      value: row.value as string,
      version: row.version === null || row.version === undefined ? null : (row.version as StoreVersion),
    };
  }

  /** Issue the next version token for `target` in the open transaction. The
   *  statements in `with` run first, in the same round trip. */
  private mint(target: StoreTarget, before: InStatement[]): Promise<StoreVersion> {
    const n = this.names;
    return this.db.inTransaction(async (open) => {
      const results = await guard(open.batch([
        ...before,
        `UPDATE ${n.sequence} SET value = value + 1 WHERE id = 1 RETURNING value`,
        {
          sql: `INSERT INTO ${n.versions} (kind, collection, target_key, version)
                SELECT ?, ?, ?, ? || '-v' || value FROM ${n.sequence} WHERE id = 1
                ON CONFLICT(kind, collection, target_key) DO UPDATE SET version = excluded.version`,
          args: [...versionKey(target), this.versionPrefix],
        },
      ]));
      const minted = Number(results[before.length]!.rows[0]!.value);
      open.minted = Math.max(open.minted, minted);
      return `${this.versionPrefix}-v${minted}` as StoreVersion;
    });
  }

  private clearVersion(target: StoreTarget): InStatement {
    return {
      sql: `DELETE FROM ${this.names.versions} WHERE kind = ? AND collection = ? AND target_key = ?`,
      args: versionKey(target),
    };
  }

  private writeKey(key: string, encoded: string): Promise<StoreVersion> {
    return this.mint({ kind: "key", key }, [{
      sql: `INSERT INTO ${this.names.kv} (key, value, updated_at) VALUES (?, ?, datetime('now'))
            ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
      args: [key, encoded],
    }]);
  }

  private async writeRecord(collection: string, id: string, encoded: string): Promise<StoreVersion> {
    const table = await this.ensureTable(collection);
    return this.mint({ kind: "record", collection, id }, [{
      sql: `INSERT INTO ${table} (id, data, updated_at) VALUES (?, ?, datetime('now'))
            ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = datetime('now')`,
      args: [id, encoded],
    }]);
  }

  private async deleteKey(key: string): Promise<boolean> {
    const [deleted] = await this.db.inTransaction((open) => guard(open.batch([
      { sql: `DELETE FROM ${this.names.kv} WHERE key = ?`, args: [key] },
      this.clearVersion({ kind: "key", key }),
    ])));
    return deleted!.rowsAffected > 0;
  }

  private async deleteRecord(collection: string, id: string): Promise<boolean> {
    const table = await this.ensureTable(collection);
    const [deleted] = await this.db.inTransaction((open) => guard(open.batch([
      { sql: `DELETE FROM ${table} WHERE id = ?`, args: [id] },
      this.clearVersion({ kind: "record", collection, id }),
    ])));
    return deleted!.rowsAffected > 0;
  }

  private async backfillVersion(target: StoreTarget): Promise<StoreVersion | null> {
    const row = await this.readVersioned(target);
    if (!row) return null;
    return row.version ?? this.mint(target, []);
  }
}

// ─── Vector facet (AsyncVectorStore) — libSQL NATIVE vector search ─────────────

class LibsqlVectorFacet implements AsyncVectorStore {
  meta!: VectorStoreMeta;
  private dimensions: number;
  /** True when the native vector_top_k path is used; false to force exact JS cosine. */
  private accelerated: boolean;
  private readonly forceJsCosine: boolean;
  private readonly url: string;
  private initialized = false;

  constructor(
    private readonly db: LibsqlDatabase,
    private readonly names: TableNames,
    url: string,
    dimensions?: number,
    forceJsCosine?: boolean,
  ) {
    this.url = url;
    // Provisional; finalized in init() once persisted dims are known.
    this.dimensions = dimensions ?? -1;
    this.forceJsCosine = forceJsCosine ?? false;
    this.accelerated = false;
  }

  /** Memoized async schema init. Creates the vectors table (F32_BLOB column sized
   *  to the configured dimensions) + persists/enforces dimensionality + builds the
   *  native libsql_vector_idx so vector_top_k() can use it. */
  async init(): Promise<void> {
    if (this.initialized) return;
    const n = this.names;
    await this.db.execute(
      `CREATE TABLE IF NOT EXISTS ${n.vecMeta} (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
    );
    // Persist + enforce dimensionality so a store created at N dims can't be reopened
    // at M (which would let stale-length rows score a silent 0).
    const metaRs = await this.db.execute(
      `SELECT value FROM ${n.vecMeta} WHERE key = 'dimensions'`,
    );
    const stored = metaRs.rows[0];
    if (stored) {
      const persisted = Number(stored.value as string);
      if (this.dimensions >= 0 && this.dimensions !== persisted) {
        throw new LibsqlAdapterError("dimensions-changed",
          `Vector store at ${this.url} was created with ${persisted} dimensions, opened with ${this.dimensions}.`,
        );
      }
      this.dimensions = persisted;
    } else if (this.dimensions >= 0) {
      await this.db.execute({
        sql: `INSERT INTO ${n.vecMeta} (key, value) VALUES ('dimensions', ?)`,
        args: [String(this.dimensions)],
      });
    }
    // Create the vectors table + native index only once dimensions are known —
    // F32_BLOB requires a fixed N. KV-only adapters never touch the vector facet,
    // so a dimensionless open is valid until a vector method is called.
    if (this.dimensions >= 0) {
      await this.db.execute(
        `CREATE TABLE IF NOT EXISTS ${n.vectors} (
           collection TEXT NOT NULL,
           id TEXT NOT NULL,
           vec F32_BLOB(${this.dimensions}) NOT NULL,
           metadata TEXT,
           PRIMARY KEY (collection, id)
         )`,
      );
      // Native ANN index. vector_top_k() requires a libsql_vector_idx over the column.
      await this.db.execute(
        `CREATE INDEX IF NOT EXISTS ${n.vectorIndex}
           ON ${n.vectors} (libsql_vector_idx(vec))`,
      );
    }
    this.accelerated = !this.forceJsCosine;
    this.meta = {
      backend: "libsql",
      dimensions: Math.max(this.dimensions, 0),
      accelerated: this.accelerated,
    };
    this.initialized = true;
  }

  private assertReady(v: Vector): void {
    if (this.dimensions < 0) {
      throw new LibsqlAdapterError("dimensions-unknown",
        "LibsqlAdapter.vector requires `dimensions` — pass { dimensions } when opening.",
      );
    }
    assertDimensions(v, this.dimensions);
  }

  private upsertStatement<M extends Record<string, unknown>>(
    collection: string,
    doc: VectorDocument<M>,
  ): InStatement {
    // Bind the vector through vector32(?) — libSQL converts a JSON-array string (or
    // an f32 blob) into its native F32_BLOB on write. We pass the JSON text form so
    // there is one canonical encoding path.
    return {
      sql: `INSERT INTO ${this.names.vectors}(collection, id, vec, metadata) VALUES (?, ?, vector32(?), ?)
            ON CONFLICT(collection, id) DO UPDATE SET vec = excluded.vec, metadata = excluded.metadata`,
      args: [
        collection,
        doc.id,
        vectorToJson(doc.vector),
        doc.metadata === undefined ? null : JSON.stringify(doc.metadata),
      ],
    };
  }

  async upsert<M extends Record<string, unknown> = Record<string, unknown>>(
    collection: string,
    doc: VectorDocument<M>,
  ): Promise<void> {
    this.assertReady(doc.vector);
    await this.db.transactions.transaction(() => this.db.execute(this.upsertStatement(collection, doc)));
  }

  async upsertMany<M extends Record<string, unknown> = Record<string, unknown>>(
    collection: string,
    docs: ReadonlyArray<VectorDocument<M>>,
  ): Promise<void> {
    // Validate every vector before mutating, so a mid-array mismatch writes nothing
    // (matching the in-memory + sqlite backends' atomic upsertMany).
    for (const doc of docs) this.assertReady(doc.vector);
    if (docs.length === 0) return;
    await this.db.transactions.transaction(() =>
      this.db.inTransaction((open) => guard(open.batch(docs.map((doc) => this.upsertStatement(collection, doc))))),
    );
  }

  async get<M extends Record<string, unknown> = Record<string, unknown>>(
    collection: string,
    id: string,
  ): Promise<VectorDocument<M> | null> {
    const rs = await this.db.execute({
      sql: `SELECT id, vec, metadata FROM ${this.names.vectors} WHERE collection = ? AND id = ?`,
      args: [collection, id],
    });
    const row = rs.rows[0];
    if (!row) return null;
    return {
      id: row.id as string,
      vector: blobValueToVector(row.vec),
      metadata: row.metadata === null ? undefined : (JSON.parse(row.metadata as string) as M),
    };
  }

  async has(collection: string, id: string): Promise<boolean> {
    const rs = await this.db.execute({
      sql: `SELECT 1 FROM ${this.names.vectors} WHERE collection = ? AND id = ?`,
      args: [collection, id],
    });
    return rs.rows.length > 0;
  }

  async remove(collection: string, id: string): Promise<boolean> {
    const rs = await this.db.transactions.transaction(() =>
      this.db.execute({
        sql: `DELETE FROM ${this.names.vectors} WHERE collection = ? AND id = ?`,
        args: [collection, id],
      }),
    );
    return rs.rowsAffected > 0;
  }

  async count(collection: string): Promise<number> {
    const rs = await this.db.execute({
      sql: `SELECT COUNT(*) AS n FROM ${this.names.vectors} WHERE collection = ?`,
      args: [collection],
    });
    return Number(rs.rows[0]!.n);
  }

  async search<M extends Record<string, unknown> = Record<string, unknown>>(
    collection: string,
    query: Vector,
    opts?: VectorSearchOptions,
  ): Promise<VectorSearchResult<M>[]> {
    this.assertReady(query);
    const topK = opts?.topK ?? 10;
    const minScore = opts?.minScore;
    const hasFilters = !!(opts?.where || opts?.whereNot);
    // When pre-KNN filters are present, FORCE the JS path: vector_top_k() ranks over
    // the whole index and cannot apply metadata predicates BEFORE the KNN cut, so a
    // native query would compute topK from the unfiltered set and then filter —
    // wrong semantics. The JS path fetches the collection's rows, filters FIRST, then
    // scores — so topK is out of the passing set only. This is the load-bearing
    // correctness point and matches the in-memory + sqlite backends exactly.
    // A zero / non-finite query has no cosine direction — also use the deterministic
    // JS path there.
    if (this.accelerated && isUsableVector(query) && !hasFilters) {
      return this.searchNative<M>(collection, query, topK, minScore);
    }
    return this.searchJs<M>(collection, query, topK, minScore, opts?.where, opts?.whereNot);
  }

  private async searchNative<M extends Record<string, unknown>>(
    collection: string,
    query: Vector,
    topK: number,
    minScore: number | undefined,
  ): Promise<VectorSearchResult<M>[]> {
    // vector_top_k('index_name', query, k) returns rowids (as an `id` column) of the
    // k nearest rows by the index's metric. Join back to `vectors` to recover the
    // (collection, id, metadata) and compute the exact cosine score. The index spans
    // every collection, so over-fetch (k scaled) and filter to this collection, then
    // re-cut to topK — keeps results correct when the global top-k spills into other
    // collections.
    const overFetch = Math.max(topK * 4, topK + 16);
    const rs = await this.db.execute({
      sql: `SELECT v.id AS id,
                   v.metadata AS metadata,
                   vector_distance_cos(v.vec, vector32(?)) AS distance
            FROM vector_top_k('${this.names.vectorIndex}', vector32(?), CAST(? AS INTEGER)) AS t
            JOIN ${this.names.vectors} v ON v.rowid = t.id
            WHERE v.collection = ?`,
      args: [vectorToJson(query), vectorToJson(query), overFetch, collection],
    });
    const out: VectorSearchResult<M>[] = [];
    for (const r of rs.rows) {
      if (r.distance === null) continue;
      const score = 1 - Number(r.distance); // cosine distance → similarity
      if (!Number.isFinite(score)) continue;
      if (minScore !== undefined && score < minScore) continue;
      out.push({
        id: r.id as string,
        score,
        metadata: r.metadata === null ? undefined : (JSON.parse(r.metadata as string) as M),
      });
    }
    out.sort((a, b) => b.score - a.score || compareCodePoints(a.id, b.id));
    return out.slice(0, topK);
  }

  private async searchJs<M extends Record<string, unknown>>(
    collection: string,
    query: Vector,
    topK: number,
    minScore: number | undefined,
    where?: Record<string, unknown>,
    whereNot?: Record<string, unknown>,
  ): Promise<VectorSearchResult<M>[]> {
    const rs = await this.db.execute({
      sql: `SELECT id, vec, metadata FROM ${this.names.vectors} WHERE collection = ?`,
      args: [collection],
    });
    const scored: VectorSearchResult<M>[] = [];
    for (const row of rs.rows) {
      const meta =
        row.metadata === null ? undefined : (JSON.parse(row.metadata as string) as M);
      // Pre-KNN metadata filters — applied before scoring.
      if (where && !matchesWhere(meta, where)) continue;
      if (whereNot && matchesWhere(meta, whereNot)) continue;
      const vec = blobValueToVector(row.vec);
      if (!isUsableVector(vec)) continue; // directionless — excluded (matches every backend)
      const score = cosineSimilarity(query, vec);
      if (!Number.isFinite(score)) continue;
      if (minScore !== undefined && score < minScore) continue;
      scored.push({ id: row.id as string, score, metadata: meta });
    }
    scored.sort((a, b) => b.score - a.score || compareCodePoints(a.id, b.id));
    return scored.slice(0, topK);
  }
}

// ─── Vector encoding helpers ─────────────────────────────────────────────────

/** Encode a vector as a JSON array string for libSQL's vector32() constructor.
 *  Non-finite components serialize to JSON `null`; libSQL rejects those, so a
 *  non-finite vector is never persisted (assertReady + isUsableVector keep them
 *  out of search anyway). */
function vectorToJson(vec: Vector): string {
  return JSON.stringify(Array.from(vec, (x) => (Number.isFinite(x) ? x : 0)));
}

/** Decode a libSQL F32_BLOB column Value into a Vector. libSQL returns BLOB columns
 *  as an ArrayBuffer (not a Node Buffer), so normalize to a Uint8Array first and
 *  reuse @mirk/store's little-endian float32 decoder. */
function blobValueToVector(value: unknown): Vector {
  if (value instanceof ArrayBuffer) {
    return bufferToVector(new Uint8Array(value));
  }
  if (value instanceof Uint8Array) {
    return bufferToVector(value);
  }
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(value)) {
    return bufferToVector(value);
  }
  // Defensive: some drivers may hand back a typed-array view.
  if (ArrayBuffer.isView(value)) {
    const view = value as ArrayBufferView;
    return bufferToVector(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
  }
  throw new Error(`Unexpected vec column type: ${Object.prototype.toString.call(value)}`);
}
