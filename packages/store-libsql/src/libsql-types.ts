import type { SqliteMigrationOptions } from "@mirk/store/sql";
import type { Client } from "@libsql/client";
import type {
  AsyncAtomicMutationStore,
  AsyncReceiptPruning,
  AsyncStore,
  AsyncStoreInQuery,
  AsyncStoreIndexes,
  AtomicMutationLimits,
} from "@mirk/store";

export interface LibsqlAdapterOptions extends SqliteMigrationOptions {
  /** libSQL connection URL: `libsql://…` (remote/Turso), `file:./db.sqlite`, or `:memory:`. */
  url: string;
  /** Auth token for a remote (Turso) database. Ignored for file:/:memory:. */
  authToken?: string;
  /** Existing @libsql/client to reuse (shares one connection). When passed, the
   *  adapter never closes it on `close()` — ownership stays with the caller. */
  client?: Client;
  /** Logical vector namespace, shared by collections. */
  namespace?: string;
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
  /** How long, in milliseconds, an idempotency receipt is kept. A request
   *  whose key matches only an expired receipt is applied as new. Defaults to
   *  keeping receipts forever. */
  receiptRetentionMs?: number;
  /** The clock, in milliseconds since the epoch, that stamps and expires
   *  idempotency receipts. Defaults to the database's clock, so every host
   *  writing to the database agrees on a receipt's age. */
  now?: () => number;
}

export type LibsqlClientFactory = (config: {
  url: string;
  authToken?: string;
}) => Client;

export type LibsqlClient = Client;

export type LibsqlKvStore = AsyncStore &
  AsyncStoreInQuery &
  AsyncStoreIndexes &
  AsyncAtomicMutationStore &
  AsyncReceiptPruning;
