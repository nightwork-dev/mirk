import { randomUUID } from "node:crypto";

import { Pool, type PoolClient, type PoolConfig, type QueryResult } from "pg";

import type {
  AfterCommitNotify,
  AsyncAtomicMutationStore,
  AsyncReceiptPruning,
  AsyncStore,
  AsyncStoreInQuery,
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
import {
  AtomicMutationIndeterminateError,
  RECEIPT_PRUNE_BATCH,
  resolveAtomicLimits,
  resolveReceiptRetention,
  validateAtomicRequest,
} from "@mirk/store/atomic";
import { AsyncTransactionCoordinator } from "@mirk/store/transaction";

export type PostgresAdapterErrorCode =
  | "conflicting-pool-options"
  | "empty-schema"
  | "adapter-closed"
  | "invalid-timeout";

/** Thrown for invalid adapter options, or for a transaction after `close()`. */
export class PostgresAdapterError extends Error {
  declare readonly name: "PostgresAdapterError";
  readonly code: PostgresAdapterErrorCode;

  constructor(code: PostgresAdapterErrorCode, message: string) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
    this.code = code;
  }
}
Object.defineProperty(PostgresAdapterError.prototype, "name", {
  value: "PostgresAdapterError",
  writable: true,
  configurable: true,
  enumerable: false,
});

export type PostgresValueErrorCode = "not-json-serializable";

/** Thrown when a stored value cannot be encoded as JSON. */
export class PostgresValueError extends TypeError {
  declare readonly name: "PostgresValueError";
  readonly code: PostgresValueErrorCode;

  constructor(code: PostgresValueErrorCode, message: string) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
    this.code = code;
  }
}
Object.defineProperty(PostgresValueError.prototype, "name", {
  value: "PostgresValueError",
  writable: true,
  configurable: true,
  enumerable: false,
});

export type PostgresRangeErrorCode = "invalid-integer";

/** Thrown when a pagination argument is not a non-negative integer. */
export class PostgresRangeError extends RangeError {
  declare readonly name: "PostgresRangeError";
  readonly code: PostgresRangeErrorCode;

  constructor(code: PostgresRangeErrorCode, message: string) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
    this.code = code;
  }
}
Object.defineProperty(PostgresRangeError.prototype, "name", {
  value: "PostgresRangeError",
  writable: true,
  configurable: true,
  enumerable: false,
});

export interface PostgresAdapterOptions {
  /** PostgreSQL connection string used when the adapter owns its pool. */
  connectionString?: string;
  /** Additional node-postgres pool configuration. */
  poolConfig?: Omit<PoolConfig, "connectionString">;
  /** Caller-owned pool shared with other adapters or application queries. */
  pool?: Pool;
  /** PostgreSQL schema for Mirk's fixed tables. Defaults to `mirk`. */
  schema?: string;
  /** Override the atomic request bounds `.kv` enforces. Defaults to the
   *  portable remote limits. */
  atomicLimits?: Partial<AtomicMutationLimits>;
  /** How long, in milliseconds, a transaction may sit idle between
   *  statements before PostgreSQL ends its session and releases its locks.
   *  This bounds how long a frozen or killed host can block other writers.
   *  Defaults to 60000; 0 disables the limit. */
  transactionIdleTimeoutMs?: number;
  /** How long, in milliseconds, an idempotency receipt is kept. A request
   *  whose key matches only an expired receipt is applied as new. Defaults to
   *  keeping receipts forever. */
  receiptRetentionMs?: number;
  /** The clock, in milliseconds since the epoch, that stamps and expires
   *  idempotency receipts. Defaults to the database's clock, so every host
   *  writing to the schema agrees on a receipt's age. */
  now?: () => number;
}

/** Not part of the public options: the conformance replay pins the prefix of
 *  version tokens so their exact values can be compared. Not exported from the
 *  package entry. */
export interface PostgresAdapterTestOptions extends PostgresAdapterOptions {
  versionIdentity?: string;
}

interface Queryable {
  query<R extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<R>>;
}

type PostgresStore = AsyncStore & AsyncStoreInQuery & AsyncAtomicMutationStore & AsyncReceiptPruning;

/** Transport failures after which a COMMIT may or may not have taken effect. */
const INDETERMINATE_CODES = new Set(["ECONNRESET", "EPIPE", "ETIMEDOUT", "57P01", "08000", "08003", "08006"]);

/** A server that ends a session (for example after the idle-in-transaction
 *  timeout) makes node-postgres emit `error` on the client. Without a listener
 *  that event would crash the process; the failed query already reports it. */
const ignoreConnectionError = (): void => undefined;

/** Errors raised while COMMIT was in flight. Only these can leave a
 *  transaction's outcome unknown; a failure before COMMIT was sent never
 *  applied anything. */
const commitFailures = new WeakSet<object>();

function isIndeterminateFailure(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string" && INDETERMINATE_CODES.has(code)) return true;
  const message = (error as { message?: unknown }).message;
  return typeof message === "string" && message.includes("Connection terminated");
}

/**
 * PostgreSQL source adapter. `kv` implements `AsyncStore`, `AsyncStoreInQuery`,
 * and `AsyncAtomicMutationStore`; the adapter implements
 * `AsyncStoreTransactions`.
 *
 * Every write, and every transaction, holds a transaction-scoped advisory lock
 * on the schema, so writers to one schema are serialized across connections
 * and hosts. Reads do not take the lock.
 */
export class PostgresAdapter implements AsyncStoreTransactions {
  readonly kv: PostgresStore;
  private closed = false;
  private readonly transactions: AsyncTransactionCoordinator<PoolClient>;

  private constructor(
    private readonly pool: Pool,
    private readonly ownsPool: boolean,
    schema: string,
    options: PostgresAdapterOptions,
  ) {
    const lockKey = `mirk:${schema}`;
    const idleTimeoutMs = options.transactionIdleTimeoutMs ?? 60_000;
    this.transactions = new AsyncTransactionCoordinator<PoolClient>({
      begin: async () => {
        if (this.closed) throw new PostgresAdapterError("adapter-closed", "The PostgreSQL adapter is closed.");
        const client = await pool.connect();
        client.on("error", ignoreConnectionError);
        try {
          await client.query(`BEGIN; SET LOCAL idle_in_transaction_session_timeout = ${idleTimeoutMs}`);
          await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [lockKey]);
        } catch (error) {
          client.removeListener("error", ignoreConnectionError);
          client.release(true);
          throw error;
        }
        return client;
      },
      commit: async (client) => {
        let result: QueryResult;
        try {
          result = await client.query("COMMIT");
        } catch (error) {
          if (typeof error === "object" && error !== null) commitFailures.add(error);
          throw error;
        }
        if (result.command !== "COMMIT") {
          throw new Error("PostgreSQL rolled the transaction back instead of committing it.");
        }
      },
      rollback: async (client) => {
        await client.query("ROLLBACK");
      },
      savepoint: async (client, name) => {
        await client.query(`SAVEPOINT ${name}`);
      },
      releaseSavepoint: async (client, name) => {
        await client.query(`RELEASE SAVEPOINT ${name}`);
      },
      rollbackToSavepoint: async (client, name) => {
        await client.query(`ROLLBACK TO SAVEPOINT ${name}`);
      },
      end: (client, cleanupError) => {
        client.removeListener("error", ignoreConnectionError);
        client.release(cleanupError === undefined ? undefined : true);
      },
    });
    const database: Queryable = {
      query: async (text, values) =>
        this.transactions.withConnection((client) => (client ?? pool).query(text, values as unknown[])),
    };
    this.kv = new PostgresStoreFacet(
      database,
      schema,
      this.transactions,
      resolveAtomicLimits(options.atomicLimits),
      resolveReceiptRetention(options.receiptRetentionMs),
      options.now,
    );
  }

  static async open(options: PostgresAdapterOptions = {}): Promise<PostgresAdapter> {
    if (options.pool && (options.connectionString !== undefined || options.poolConfig !== undefined)) {
      throw new PostgresAdapterError("conflicting-pool-options", "Pass either `pool` or owned-pool connection options, not both.");
    }
    const schema = options.schema ?? "mirk";
    if (schema.length === 0) throw new PostgresAdapterError("empty-schema", "PostgreSQL schema must not be empty.");
    const idleTimeoutMs = options.transactionIdleTimeoutMs;
    if (idleTimeoutMs !== undefined && (!Number.isSafeInteger(idleTimeoutMs) || idleTimeoutMs < 0 || idleTimeoutMs > 2_147_483_647)) {
      throw new PostgresAdapterError("invalid-timeout", "transactionIdleTimeoutMs must be an integer from 0 to 2147483647.");
    }
    const ownsPool = options.pool === undefined;
    const pool = options.pool ?? new Pool({ ...options.poolConfig, connectionString: options.connectionString });
    if (ownsPool) pool.on("error", ignoreConnectionError);
    const adapter = new PostgresAdapter(pool, ownsPool, schema, options);
    try {
      await adapter.transaction(() =>
        (adapter.kv as PostgresStoreFacet).init(
          schema,
          (options as PostgresAdapterTestOptions).versionIdentity ?? randomUUID(),
        ),
      );
      return adapter;
    } catch (error) {
      if (ownsPool) await pool.end().catch(() => undefined);
      throw error;
    }
  }

  /** Run short, database-only work in one transaction on one pooled client.
   *  Every `kv` call inside `work` joins it; a nested call is a savepoint. Do
   *  network or object-storage work before or after, never inside: the
   *  transaction holds the schema's write lock until it ends. */
  transaction<T>(work: () => T | Promise<T>): Promise<T> {
    return this.transactions.transaction(work);
  }

  afterCommit(notify: AfterCommitNotify): void {
    this.transactions.afterCommit(notify);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.ownsPool) await this.pool.end();
  }
}

type CompletedResult = AtomicCompletedMutationResult;

class PostgresStoreFacet implements PostgresStore {
  readonly meta: StoreMeta = { backend: "postgres" };
  private readonly kvTable: string;
  private readonly recordsTable: string;
  private readonly receiptsTable: string;
  private readonly stateTable: string;
  private readonly versionSequence: string;
  /** One statement that consumes the next version token. */
  private readonly mint: string;

  constructor(
    private readonly database: Queryable,
    schema: string,
    private readonly transactions: AsyncTransactionCoordinator<PoolClient>,
    readonly atomicLimits: AtomicMutationLimits,
    readonly receiptRetentionMs: number | undefined,
    private readonly now: (() => number) | undefined,
  ) {
    const quotedSchema = quoteIdentifier(schema);
    this.kvTable = `${quotedSchema}.kv`;
    this.recordsTable = `${quotedSchema}.records`;
    this.receiptsTable = `${quotedSchema}.atomic_receipts`;
    this.stateTable = `${quotedSchema}.atomic_state`;
    this.versionSequence = `${quotedSchema}.atomic_versions`;
    // nextval is not transactional, so a rolled-back write never gives its
    // token to a later one.
    this.mint = `SELECT (SELECT identity FROM ${this.stateTable} WHERE id = 1)
      || '-v' || nextval('${this.versionSequence.replaceAll("'", "''")}') AS version`;
  }

  async init(schema: string, versionIdentity: string): Promise<void> {
    const quotedSchema = this.kvTable.slice(0, this.kvTable.lastIndexOf("."));
    await this.database.query(`CREATE SCHEMA IF NOT EXISTS ${quotedSchema}`);
    await this.database.query(`
      CREATE TABLE IF NOT EXISTS ${this.kvTable} (
        key TEXT PRIMARY KEY,
        value JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        version TEXT
      )
    `);
    await this.database.query(`
      CREATE TABLE IF NOT EXISTS ${this.recordsTable} (
        collection TEXT NOT NULL,
        id TEXT NOT NULL,
        data JSONB NOT NULL,
        ordinal BIGINT GENERATED ALWAYS AS IDENTITY,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        version TEXT,
        PRIMARY KEY (collection, id)
      )
    `);
    await this.database.query(`
      CREATE TABLE IF NOT EXISTS ${this.receiptsTable} (
        key TEXT PRIMARY KEY,
        request_digest TEXT NOT NULL,
        result JSONB NOT NULL,
        created_at BIGINT
      )
    `);
    // Receipts written by an earlier release carry no creation time.
    const receiptColumn = await this.database.query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = 'atomic_receipts' AND column_name = 'created_at'`,
      [schema],
    );
    if ((receiptColumn.rowCount ?? 0) === 0) {
      await this.database.query(`ALTER TABLE ${this.receiptsTable} ADD COLUMN created_at BIGINT`);
    }
    await this.database.query(
      `CREATE INDEX IF NOT EXISTS atomic_receipts_created_at ON ${this.receiptsTable} (created_at)`,
    );
    await this.database.query(`
      CREATE TABLE IF NOT EXISTS ${this.stateTable} (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        identity TEXT NOT NULL
      )
    `);
    await this.database.query(`CREATE SEQUENCE IF NOT EXISTS ${this.versionSequence}`);
    await this.database.query(
      `INSERT INTO ${this.stateTable} (id, identity) VALUES (1, $1) ON CONFLICT (id) DO NOTHING`,
      [versionIdentity],
    );
    // Tables from an earlier release have no version column, and earlier
    // hand-patched deployments used a UUID column with a default. Alter only
    // what needs it: ALTER TABLE locks the table even when it changes nothing.
    const columns = await this.database.query<{ table_name: string; data_type: string }>(
      `SELECT table_name, data_type FROM information_schema.columns
       WHERE table_schema = $1 AND table_name IN ('kv', 'records') AND column_name = 'version'`,
      [schema],
    );
    for (const name of ["kv", "records"]) {
      const type = columns.rows.find((row) => row.table_name === name)?.data_type;
      if (type === "text") continue;
      const table = `${quotedSchema}.${quoteIdentifier(name)}`;
      await this.database.query(
        type === undefined
          ? `ALTER TABLE ${table} ADD COLUMN version TEXT`
          : `ALTER TABLE ${table} ALTER COLUMN version DROP DEFAULT, ALTER COLUMN version DROP NOT NULL, ALTER COLUMN version TYPE TEXT USING version::text`,
      );
      await this.database.query(
        `UPDATE ${table} SET version = (SELECT identity FROM ${this.stateTable} WHERE id = 1) || '-u' || gen_random_uuid()
         WHERE version IS NULL`,
      );
    }
  }

  async get<T>(key: string): Promise<T | null> {
    const result = await this.database.query<{ value: T }>(
      `SELECT value FROM ${this.kvTable} WHERE key = $1`,
      [key],
    );
    return result.rows[0]?.value ?? null;
  }

  async set<T>(key: string, value: T): Promise<void> {
    const encoded = encodeJson(value);
    await this.write(() => this.writeKey(key, encoded));
  }

  async has(key: string): Promise<boolean> {
    const result = await this.database.query(
      `SELECT 1 FROM ${this.kvTable} WHERE key = $1`,
      [key],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async delete(key: string): Promise<boolean> {
    return this.write(() => this.deleteKey(key));
  }

  async keys(prefix?: string): Promise<string[]> {
    const result = prefix === undefined
      ? await this.database.query<{ key: string }>(`SELECT key FROM ${this.kvTable} ORDER BY key COLLATE "C"`)
      : await this.database.query<{ key: string }>(
          `SELECT key FROM ${this.kvTable}
           WHERE left(key, char_length($1)) = $1 ORDER BY key COLLATE "C"`,
          [prefix],
        );
    return result.rows.map((row) => row.key);
  }

  async list<T>(collection: string, filter?: StoreFilter): Promise<T[]> {
    const query = buildListQuery(this.recordsTable, collection, filter);
    const result = await this.database.query<{ data: T }>(query.sql, query.values);
    return result.rows.map((row) => row.data);
  }

  async listWhereIn<T>(
    collection: string,
    field: string,
    values: readonly unknown[],
    filter?: StoreFilter,
  ): Promise<T[]> {
    if (values.length === 0) return [];
    const query = buildListQuery(this.recordsTable, collection, filter, { field, values });
    const result = await this.database.query<{ data: T }>(query.sql, query.values);
    return result.rows.map((row) => row.data);
  }

  async getById<T>(collection: string, id: string): Promise<T | null> {
    const result = await this.database.query<{ data: T }>(
      `SELECT data FROM ${this.recordsTable} WHERE collection = $1 AND id = $2`,
      [collection, id],
    );
    return result.rows[0]?.data ?? null;
  }

  async put<T extends { id: string }>(collection: string, item: T): Promise<T> {
    const encoded = encodeJson(item);
    await this.write(() => this.writeRecord(collection, item.id, encoded));
    return item;
  }

  async remove(collection: string, id: string): Promise<boolean> {
    return this.write(() => this.deleteRecord(collection, id));
  }

  async count(collection: string, filter?: StoreFilter): Promise<number> {
    const query = buildWhere(collection, filter?.where);
    const result = await this.database.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM ${this.recordsTable}${query.sql}`,
      query.values,
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  async getVersioned<T>(target: StoreTarget): Promise<VersionedStoreValue<T> | null> {
    const result = target.kind === "key"
      ? await this.database.query<{ value: T; version: string | null }>(
          `SELECT value, version FROM ${this.kvTable} WHERE key = $1`,
          [target.key],
        )
      : await this.database.query<{ value: T; version: string | null }>(
          `SELECT data AS value, version FROM ${this.recordsTable} WHERE collection = $1 AND id = $2`,
          [target.collection, target.id],
        );
    const row = result.rows[0];
    if (!row) return null;
    // A row written by an adapter that predates version tokens.
    const version = row.version ?? (await this.write(() => this.backfillVersion(target)));
    return version === null ? null : { value: row.value, version: version as StoreVersion };
  }

  async mutateAtomically(request: AtomicMutationRequest): Promise<AtomicMutationResult> {
    const validated = validateAtomicRequest(request, this.atomicLimits);
    const outermost = !this.transactions.inTransaction();
    try {
      return await this.write(() => this.decideAtomic(validated));
    } catch (error) {
      // Only the outermost COMMIT can be lost in flight. A failure before it
      // was sent, or inside a caller's transaction, is definite.
      if (outermost && typeof error === "object" && error !== null && commitFailures.has(error) && isIndeterminateFailure(error)) {
        const key = validated.idempotency?.key;
        throw new AtomicMutationIndeterminateError(
          validated.requestDigest,
          key,
          key === undefined ? "manual-reconciliation" : "retry-with-same-key",
        );
      }
      throw error;
    }
  }

  private async decideAtomic(validated: ReturnType<typeof validateAtomicRequest>): Promise<AtomicMutationResult> {
    const key = validated.idempotency?.key;
    const now = key === undefined ? null : this.clock();
    if (key !== undefined) {
      await this.pruneReceiptBatch(now);
      const prior = await this.readReceipt(key, now);
      if (prior) {
        if (prior.request_digest !== validated.requestDigest) {
          return {
            status: "idempotency-conflict",
            key,
            expectedRequestDigest: prior.request_digest,
            receivedRequestDigest: validated.requestDigest,
          };
        }
        return {
          status: "replayed",
          requestDigest: prior.result.requestDigest,
          versions: prior.result.versions,
          ...(prior.result.outcome === undefined ? {} : { outcome: prior.result.outcome }),
        };
      }
    }

    // One query reads every condition target. The transaction holds the
    // schema's write lock, so the writes below apply to the state it reads.
    if (validated.conditions.length > 0) {
      const targets = validated.conditions.map(({ target }) => target);
      const observed = await this.database.query<{ present: boolean; version: string | null }>(
        `SELECT (k.key IS NOT NULL OR r.id IS NOT NULL) AS present, COALESCE(k.version, r.version) AS version
         FROM unnest($1::text[], $2::text[], $3::text[]) WITH ORDINALITY AS t(kind, collection, target_key, ord)
         LEFT JOIN ${this.kvTable} AS k ON t.kind = 'key' AND k.key = t.target_key
         LEFT JOIN ${this.recordsTable} AS r
           ON t.kind = 'record' AND r.collection = t.collection AND r.id = t.target_key
         ORDER BY t.ord`,
        [
          targets.map((target) => target.kind),
          targets.map((target) => (target.kind === "key" ? null : target.collection)),
          targets.map((target) => (target.kind === "key" ? target.key : target.id)),
        ],
      );
      for (const [index, condition] of validated.conditions.entries()) {
        const row = observed.rows[index]!;
        const matches = condition.expected === "missing"
          ? !row.present
          : condition.expected === "present"
            ? row.present
            : row.version === condition.version;
        if (matches) continue;
        let reported: StoreVersion | "missing" | "present" = row.present ? "present" : "missing";
        if (row.present && condition.expected === "version") {
          // A row written by an adapter that predates version tokens gets one now.
          reported = (row.version ?? (await this.write(() => this.backfillVersion(condition.target))) ?? "missing") as
            | StoreVersion
            | "missing";
        }
        return { status: "conflict", condition, observed: reported };
      }
    }

    // One statement applies every operation and issues the version tokens,
    // increasing in operation order.
    const ops: string[] = [];
    const collections: (string | null)[] = [];
    const targetKeys: string[] = [];
    const values: (string | null)[] = [];
    for (const operation of validated.operations) {
      ops.push(operation.op);
      switch (operation.op) {
        case "set":
          collections.push(null);
          targetKeys.push(operation.key);
          values.push(encodeJson(operation.value));
          break;
        case "delete":
          collections.push(null);
          targetKeys.push(operation.key);
          values.push(null);
          break;
        case "put":
          collections.push(operation.collection);
          targetKeys.push(operation.item.id);
          values.push(encodeJson(operation.item));
          break;
        case "remove":
          collections.push(operation.collection);
          targetKeys.push(operation.id);
          values.push(null);
          break;
      }
    }
    const issuing = validated.operations.filter((operation) => operation.op === "set" || operation.op === "put").length;
    const written = await this.database.query<{ ord: string; version: StoreVersion }>(
      `WITH ops AS (
         SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::text[])
           WITH ORDINALITY AS o(op, collection, target_key, value, ord)
       ),
       issuing AS (
         SELECT ops.*, row_number() OVER (ORDER BY ord) AS rank FROM ops WHERE op IN ('set', 'put')
       ),
       minted AS (
         SELECT v, row_number() OVER (ORDER BY v) AS rank
         FROM (SELECT nextval('${this.versionSequence.replaceAll("'", "''")}') AS v FROM generate_series(1, $5::int)) AS s
       ),
       versioned AS (
         SELECT i.op, i.collection, i.target_key, i.value::jsonb AS value, i.ord,
           (SELECT identity FROM ${this.stateTable} WHERE id = 1) || '-v' || m.v AS version
         FROM issuing AS i JOIN minted AS m USING (rank)
       ),
       set_keys AS (
         INSERT INTO ${this.kvTable} (key, value, updated_at, version)
         SELECT target_key, value, now(), version FROM versioned WHERE op = 'set' ORDER BY ord
         ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = now(), version = excluded.version
       ),
       put_records AS (
         INSERT INTO ${this.recordsTable} (collection, id, data, updated_at, version)
         SELECT collection, target_key, value, now(), version FROM versioned WHERE op = 'put' ORDER BY ord
         ON CONFLICT (collection, id) DO UPDATE SET data = excluded.data, updated_at = now(), version = excluded.version
       ),
       deleted_keys AS (
         DELETE FROM ${this.kvTable} WHERE key IN (SELECT target_key FROM ops WHERE op = 'delete')
       ),
       removed_records AS (
         DELETE FROM ${this.recordsTable} AS r USING ops
         WHERE ops.op = 'remove' AND r.collection = ops.collection AND r.id = ops.target_key
       )
       SELECT ord::text AS ord, version FROM versioned ORDER BY ord`,
      [ops, collections, targetKeys, values, issuing],
    );
    const issued = new Map(written.rows.map((row) => [Number(row.ord) - 1, row.version]));
    const versions = validated.operations.map((operation, index) => ({
      target: operation.op === "set" || operation.op === "delete"
        ? { kind: "key" as const, key: operation.key }
        : { kind: "record" as const, collection: operation.collection, id: operation.op === "put" ? operation.item.id : operation.id },
      version: issued.get(index) ?? null,
    }));
    const applied: CompletedResult = {
      status: "applied",
      requestDigest: validated.requestDigest,
      versions,
      ...(validated.outcome === undefined ? {} : { outcome: validated.outcome }),
    };
    if (key !== undefined) await this.writeReceipt(key, validated.requestDigest, applied, now);
    return applied;
  }

  async pruneExpiredReceipts(): Promise<number> {
    if (this.receiptRetentionMs === undefined) return 0;
    let removed = 0;
    for (;;) {
      const batch = await this.write(() => this.pruneReceiptBatch(this.clock()));
      removed += batch;
      if (batch < RECEIPT_PRUNE_BATCH) return removed;
    }
  }

  // ─── Idempotency receipts ──────────────────────────────────────────────────
  // Every receipt read and write goes through these methods. `now` is the
  // injected clock's reading, or null to use the database's clock.

  private clock(): number | null {
    return this.now === undefined ? null : this.now();
  }

  /** The SQL for "now" in milliseconds, given the parameter that carries an
   *  injected reading or null. */
  private static nowSql(parameter: string): string {
    return `COALESCE(${parameter}::bigint, (extract(epoch FROM now()) * 1000)::bigint)`;
  }

  /** The live receipt under `key`, or undefined when there is none or it has
   *  expired. */
  private async readReceipt(
    key: string,
    now: number | null,
  ): Promise<{ request_digest: string; result: CompletedResult } | undefined> {
    const live = this.receiptRetentionMs === undefined
      ? ""
      : ` AND (created_at IS NULL OR created_at >= ${PostgresStoreFacet.nowSql("$2")} - $3::bigint)`;
    const values = this.receiptRetentionMs === undefined ? [key] : [key, now, this.receiptRetentionMs];
    const result = await this.database.query<{ request_digest: string; result: CompletedResult }>(
      `SELECT request_digest, result FROM ${this.receiptsTable} WHERE key = $1${live}`,
      values,
    );
    return result.rows[0];
  }

  /** Write a receipt, replacing an expired one under the same key. */
  private async writeReceipt(key: string, requestDigest: string, result: CompletedResult, now: number | null): Promise<void> {
    await this.database.query(
      `INSERT INTO ${this.receiptsTable} (key, request_digest, result, created_at)
       VALUES ($1, $2, $3::jsonb, ${PostgresStoreFacet.nowSql("$4")})
       ON CONFLICT (key) DO UPDATE SET request_digest = excluded.request_digest,
         result = excluded.result, created_at = excluded.created_at`,
      [key, requestDigest, encodeJson(result), now],
    );
  }

  /** In the open transaction, stamp at most one batch of receipts that have no
   *  creation time with now, then delete at most one batch of expired receipts.
   *  Returns how many were deleted. */
  private async pruneReceiptBatch(now: number | null): Promise<number> {
    if (this.receiptRetentionMs === undefined) return 0;
    await this.database.query(
      `UPDATE ${this.receiptsTable} SET created_at = ${PostgresStoreFacet.nowSql("$1")}
       WHERE key IN (SELECT key FROM ${this.receiptsTable} WHERE created_at IS NULL LIMIT $2)`,
      [now, RECEIPT_PRUNE_BATCH],
    );
    const deleted = await this.database.query(
      `DELETE FROM ${this.receiptsTable} WHERE key IN (
         SELECT key FROM ${this.receiptsTable}
         WHERE created_at < ${PostgresStoreFacet.nowSql("$1")} - $2::bigint
         ORDER BY created_at LIMIT $3)`,
      [now, this.receiptRetentionMs, RECEIPT_PRUNE_BATCH],
    );
    return deleted.rowCount ?? 0;
  }

  /** Every write holds the schema lock: alone in its own transaction, or as a
   *  savepoint of the caller's, so a failed statement leaves it usable. */
  private write<T>(work: () => Promise<T>): Promise<T> {
    return this.transactions.transaction(work);
  }

  private async writeKey(key: string, encoded: string): Promise<StoreVersion> {
    const result = await this.database.query<{ version: StoreVersion }>(
      `WITH minted AS (${this.mint})
       INSERT INTO ${this.kvTable} (key, value, updated_at, version)
       SELECT $1, $2::jsonb, now(), minted.version FROM minted
       ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = now(), version = excluded.version
       RETURNING version`,
      [key, encoded],
    );
    return result.rows[0]!.version;
  }

  private async writeRecord(collection: string, id: string, encoded: string): Promise<StoreVersion> {
    const result = await this.database.query<{ version: StoreVersion }>(
      `WITH minted AS (${this.mint})
       INSERT INTO ${this.recordsTable} (collection, id, data, updated_at, version)
       SELECT $1, $2, $3::jsonb, now(), minted.version FROM minted
       ON CONFLICT (collection, id) DO UPDATE SET data = excluded.data, updated_at = now(), version = excluded.version
       RETURNING version`,
      [collection, id, encoded],
    );
    return result.rows[0]!.version;
  }

  private async deleteKey(key: string): Promise<boolean> {
    const result = await this.database.query(`DELETE FROM ${this.kvTable} WHERE key = $1`, [key]);
    return (result.rowCount ?? 0) > 0;
  }

  private async deleteRecord(collection: string, id: string): Promise<boolean> {
    const result = await this.database.query(
      `DELETE FROM ${this.recordsTable} WHERE collection = $1 AND id = $2`,
      [collection, id],
    );
    return (result.rowCount ?? 0) > 0;
  }

  private async backfillVersion(target: StoreTarget): Promise<string | null> {
    const result = target.kind === "key"
      ? await this.database.query<{ version: string }>(
          `WITH minted AS (${this.mint})
           UPDATE ${this.kvTable} AS target_row SET version = COALESCE(target_row.version, minted.version) FROM minted
           WHERE target_row.key = $1 RETURNING target_row.version`,
          [target.key],
        )
      : await this.database.query<{ version: string }>(
          `WITH minted AS (${this.mint})
           UPDATE ${this.recordsTable} AS target_row SET version = COALESCE(target_row.version, minted.version) FROM minted
           WHERE target_row.collection = $1 AND target_row.id = $2 RETURNING target_row.version`,
          [target.collection, target.id],
        );
    return result.rows[0]?.version ?? null;
  }
}

function buildListQuery(
  table: string,
  collection: string,
  filter?: StoreFilter,
  inQuery?: { field: string; values: readonly unknown[] },
): { sql: string; values: unknown[] } {
  const where = buildWhere(collection, filter?.where, inQuery);
  let sql = `SELECT data FROM ${table}${where.sql}`;
  const values = where.values;
  if (filter?.sortBy) {
    values.push(filter.sortBy);
    const field = `$${values.length}`;
    const direction = filter.sortDir === "desc" ? "DESC" : "ASC";
    const value = `data -> ${field}`;
    const kind = `jsonb_typeof(${value})`;
    // Missing and null last. Otherwise jsonb's own order across and within
    // types, except that strings compare in "C" collation: byte order of
    // UTF-8, which is the contract's code point order on any server locale.
    sql += ` ORDER BY CASE WHEN NOT (data ? ${field}) OR ${kind} = 'null' THEN 1 ELSE 0 END ASC,`
      + ` CASE ${kind} WHEN 'string' THEN 1 WHEN 'number' THEN 2 WHEN 'boolean' THEN 3 WHEN 'array' THEN 4 WHEN 'object' THEN 5 END ${direction} NULLS LAST,`
      + ` CASE WHEN ${kind} = 'string' THEN ${value} #>> '{}' END COLLATE "C" ${direction} NULLS LAST,`
      + ` CASE WHEN ${kind} IN ('number', 'boolean', 'array', 'object') THEN ${value} END ${direction} NULLS LAST,`
      + ` ordinal ASC`;
  } else {
    sql += " ORDER BY ordinal ASC";
  }
  if (filter?.limit !== undefined) {
    assertNonNegativeInteger("limit", filter.limit);
    values.push(filter.limit);
    sql += ` LIMIT $${values.length}`;
  }
  if (filter?.offset !== undefined) {
    assertNonNegativeInteger("offset", filter.offset);
    values.push(filter.offset);
    sql += ` OFFSET $${values.length}`;
  }
  return { sql, values };
}

function buildWhere(
  collection: string,
  where?: Record<string, unknown>,
  inQuery?: { field: string; values: readonly unknown[] },
): { sql: string; values: unknown[] } {
  const values: unknown[] = [collection];
  const clauses = ["collection = $1"];
  for (const [field, value] of Object.entries(where ?? {})) {
    values.push(field);
    const fieldParameter = `$${values.length}`;
    values.push(encodeJson(value));
    const valueParameter = `$${values.length}`;
    clauses.push(`data ? ${fieldParameter} AND data -> ${fieldParameter} = ${valueParameter}::jsonb`);
  }
  if (inQuery) {
    values.push(inQuery.field);
    const fieldParameter = `$${values.length}`;
    values.push(encodeJson(inQuery.values));
    const valuesParameter = `$${values.length}`;
    clauses.push(
      `data ? ${fieldParameter} AND EXISTS (
         SELECT 1 FROM jsonb_array_elements(${valuesParameter}::jsonb) candidate
         WHERE data -> ${fieldParameter} = candidate
       )`,
    );
  }
  return { sql: ` WHERE ${clauses.join(" AND ")}`, values };
}

function encodeJson(value: unknown): string {
  const encoded = JSON.stringify(value, (_key, nested) => {
    if (
      nested === undefined ||
      typeof nested === "function" ||
      typeof nested === "symbol" ||
      typeof nested === "bigint" ||
      (typeof nested === "number" && !Number.isFinite(nested))
    ) {
      throw new PostgresValueError("not-json-serializable", "Postgres store values must be JSON-serializable.");
    }
    return nested;
  });
  if (encoded === undefined) throw new PostgresValueError("not-json-serializable", "Postgres store values must be JSON-serializable.");
  return encoded;
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function assertNonNegativeInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new PostgresRangeError("invalid-integer", `${name} must be a non-negative integer.`);
  }
}
