import type { SqliteMigrationResult } from "@mirk/store/sql";
import type { Client } from "@libsql/client";
import type { AfterCommitNotify, AsyncStoreTransactions } from "@mirk/store";
import type { AsyncVectorStore } from "@mirk/store/vector";
import { ensureMirkRegistry } from "./libsql-format.js";
import { LibsqlVectorFacet } from "./libsql-vector.js";
import {
  DEFAULT_ATOMIC_LIMITS,
  IN_PROCESS_ATOMIC_LIMITS,
  resolveAtomicLimits,
  resolveReceiptRetention,
} from "@mirk/store/atomic";
import { LibsqlAdapterError } from "./libsql-errors.js";
import type {
  LibsqlAdapterOptions,
  LibsqlClientFactory,
  LibsqlKvStore,
} from "./libsql-types.js";
import { LibsqlDatabase } from "./libsql-database.js";
import { tableNames } from "./libsql-registry.js";
import { LibsqlKvFacet } from "./libsql-kv.js";
export { LibsqlAdapterError } from "./libsql-errors.js";
export type { LibsqlAdapterErrorCode } from "./libsql-errors.js";
export type {
  LibsqlAdapterOptions,
  LibsqlClientFactory,
  LibsqlClient,
} from "./libsql-types.js";
export { localWriterCount } from "./libsql-locks.js";

/** Multi-capability libSQL source adapter. The concrete entry point supplies the
 *  client factory so this shared core has no runtime dependency on a driver.
 *  Open once via the static `openWithFactory`; use `.kv` and/or `.vector` — both
 *  ride the same connection. */
export class LibsqlAdapterCore implements AsyncStoreTransactions {
  migrationResult!: SqliteMigrationResult;
  readonly kv: LibsqlKvStore;
  readonly vector: AsyncVectorStore;
  private readonly client: Client;
  private readonly ownsClient: boolean;
  private readonly database: LibsqlDatabase;

  protected constructor(
    client: Client,
    ownsClient: boolean,
    opts: LibsqlAdapterOptions,
  ) {
    this.client = client;
    this.ownsClient = ownsClient;
    const names = tableNames(opts.tablePrefix ?? "");
    this.database = new LibsqlDatabase(
      client,
      opts.url,
      names.sequence,
      opts.busyTimeoutMs ?? 30_000,
    );
    const local = client.protocol === "file";
    this.kv = new LibsqlKvFacet(
      this.database,
      names,
      resolveAtomicLimits(
        opts.atomicLimits,
        local ? IN_PROCESS_ATOMIC_LIMITS : DEFAULT_ATOMIC_LIMITS,
      ),
      resolveReceiptRetention(opts.receiptRetentionMs),
      opts.now,
    );
    this.vector = new LibsqlVectorFacet(
      this.database,
      opts.tablePrefix ?? "",
      opts.namespace ?? "default",
      opts.forceJsCosine,
    );
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
    this.database.close();
    if (this.ownsClient) this.client.close();
  }

  /** @internal Initialize the schema in one transaction. */
  async initialize(
    versionIdentity: string,
    options: LibsqlAdapterOptions,
    backup?: (source: string, destination: string) => void,
    explicitInvocation = false,
  ): Promise<void> {
    await this.transaction(async () => {
      this.migrationResult = await ensureMirkRegistry(
        this.database,
        tableNames(options.tablePrefix ?? ""),
        (code, message) => new LibsqlAdapterError(code, message),
        options,
        backup,
        explicitInvocation,
      );
      if (!explicitInvocation)
        await (this.kv as LibsqlKvFacet).init(versionIdentity);
    });
  }
}

/** Internal driver binding used by the Node and web entry points. This stays in
 *  the unexported core module so consumers cannot bypass an entry point's URL
 *  policy or select a runtime client implementation directly. */
export async function openLibsqlAdapter<T extends LibsqlAdapterCore>(
  opts: LibsqlAdapterOptions,
  createClient: LibsqlClientFactory,
  construct: (
    client: Client,
    ownsClient: boolean,
    opts: LibsqlAdapterOptions,
  ) => T,
  backup?: (source: string, destination: string) => void,
  explicitInvocation = false,
): Promise<T> {
  validateOptions(opts);
  if (
    opts.backupPath !== undefined &&
    (!opts.url.startsWith("file:") || !backup)
  )
    throw new LibsqlAdapterError(
      "unsupported-backup",
      "Migration backups require a local file adapter",
    );
  const ownsClient = opts.client === undefined;
  const client =
    opts.client ??
    createClient(
      opts.authToken !== undefined
        ? { url: opts.url, authToken: opts.authToken }
        : { url: opts.url },
    );
  let adapter: T | undefined;
  try {
    if (opts.backupPath !== undefined && client.protocol !== "file")
      throw new LibsqlAdapterError(
        "unsupported-backup",
        "Migration backups require a local file client",
      );
    adapter = construct(client, ownsClient, opts);
    await adapter.initialize(
      opts.versionIdentity ?? crypto.randomUUID(),
      opts,
      backup,
      explicitInvocation,
    );
    return adapter;
  } catch (err) {
    // A facet init can throw (e.g. dimension mismatch). Don't leak a client we
    // opened — but never close a client the caller passed in.
    adapter?.close();
    if (ownsClient && !adapter) {
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
  if (
    opts.tablePrefix !== undefined &&
    !/^[A-Za-z][A-Za-z0-9_]{0,47}$/.test(opts.tablePrefix)
  ) {
    throw new LibsqlAdapterError(
      "invalid-option",
      "tablePrefix must start with a letter and contain at most 48 letters, digits and underscores.",
    );
  }
  const busy = opts.busyTimeoutMs;
  if (busy !== undefined && (!Number.isSafeInteger(busy) || busy < 0)) {
    throw new LibsqlAdapterError(
      "invalid-option",
      "busyTimeoutMs must be a non-negative integer.",
    );
  }
}
