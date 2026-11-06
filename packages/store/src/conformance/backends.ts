import { JobsStore, type JobsOptions } from "@mirk/jobs";
import { jobsConformanceTarget } from "./jobs-target.js";
import { coordinationApi, memoryTransactionApi } from "../coordination/conformance.js";
import { createMemoryCoordinator, createMemoryCoordinationState } from "../coordination/memory.js";
import { SqliteCoordinator } from "../coordination/sqlite.js";
import { recordHistoryApi } from "./record-history-target.js";
import { createMemoryTransactions } from "../transaction.js";
// ─── Conformance backend targets ────────────────────────────────────────────
// The one module in src/conformance that touches a native binding: it builds a
// live target per backend for a scenario. It is TOOLING, not a package entry
// point — it is absent from the tsup build list and from package.json exports,
// so no consumer can import it and drag better-sqlite3 into a client build.
//
// Every SQLite target opens `:memory:`, so a scenario never sees another
// scenario's rows.

import { InMemoryKv, InMemorySearchStore, InMemoryVectorStore, toAsync } from "../index.js";
import {
  canonicalDigest,
  canonicalJson,
  sha256Hex,
  sha256HexBytes,
} from "../canonical.js";
import { InMemoryLogStore } from "../log/memory.js";
import type { LogStore } from "../log/types.js";
import type { JsonValue } from "../atomic.js";
import { SqliteAdapter } from "../adapters/sqlite.js";
import { NodeSqliteAdapter } from "../adapters/node-sqlite.js";
import { fixturesApi, type FixturesBackendStore } from "./fixtures-target.js";
import { artifactApi } from "./artifact-target.js";
import { openMarkdownTarget } from "./markdown-target.js";
import { neighbors, traverse, traverseFrontierBatched } from "../graph.js";
import {
  targetKindFor,
  scenarioStoreSetup,
  type BackendName,
  type Target,
  type TargetRequest,
} from "./runner.js";

export interface OpenTarget {
  target: Target;
  dispose: () => void;
}

const STORE_METHODS = [
  "get",
  "set",
  "has",
  "delete",
  "keys",
  "list",
  "getById",
  "put",
  "remove",
  "count",
  "listWhereIn",
  "ensureIndex",
  "getVersioned",
  "mutateAtomically",
  "pruneExpiredReceipts",
] as const;

/** Every version token in the corpus is pinned, so both conformance stores mint
 *  them under one identity and a token reads `conformance-v<n>`. */
const CONFORMANCE_VERSION_IDENTITY = "conformance";

/** The `hash` target: canonical JSON and SHA-256, with no backend behind them.
 *  It is the same object for both backend names — the scenario still runs twice,
 *  which costs nothing and keeps one execution path for every scenario. */
function hashApi(): Record<string, unknown> {
  return {
    canonicalJson: (value: unknown) => canonicalJson(value),
    canonicalDigest: (value: unknown) => canonicalDigest(value),
    sha256Hex: (text: string) => sha256Hex(text),
    sha256Bytes: (bytes: Uint8Array) => ({
      algorithm: "sha256",
      value: sha256HexBytes(bytes),
      sizeBytes: bytes.byteLength,
    }),
  };
}

const VECTOR_METHODS = ["ensureSpace", "listSpaces", "upsert", "upsertMany", "get", "has", "remove", "count", "search"] as const;

const SEARCH_METHODS = ["index", "indexMany", "remove", "search"] as const;

const LOG_METHODS = ["append", "get", "list", "lastSequence", "lastCursor", "deleteStream"] as const;

/** The log target: the port's methods, plus `appendRolledBack(stream,
 *  record)`, which appends inside the backend's own transaction, rolls that
 *  transaction back, and returns the sequence the append was given. */
function logApi(
  log: LogStore,
  transaction: (work: () => void) => void,
): Record<string, unknown> {
  return {
    ...methodApi(log, LOG_METHODS),
    deleteRolledBack: (stream: string, record?: JsonValue) => {
      const rollback = new Error("roll back");
      let removed = false;
      try {
        transaction(() => {
          removed = log.deleteStream(stream);
          if (record !== undefined) log.append(stream, record);
          throw rollback;
        });
      } catch (error) {
        if (error !== rollback) throw error;
      }
      return removed;
    },
    appendRolledBack: (stream: string, record: JsonValue) => {
      const rollback = new Error("roll back");
      let sequence: number | undefined;
      try {
        transaction(() => {
          sequence = log.append(stream, record);
          throw rollback;
        });
      } catch (error) {
        if (error !== rollback) throw error;
      }
      return sequence;
    },
  };
}

function methodApi(instance: object, names: readonly string[]): Record<string, unknown> {
  const api: Record<string, unknown> = {};
  for (const name of names) {
    const value = (instance as Record<string, unknown>)[name];
    if (typeof value === "function") {
      api[name] = (value as (...a: unknown[]) => unknown).bind(instance);
    }
  }
  return api;
}

/** The graph facade: the three traversal primitives bound over `toAsync(store)`,
 *  plus the async store surface so a scenario can seed its edge collection. */
function graphApi(store: Parameters<typeof toAsync>[0]): Record<string, unknown> {
  const async = toAsync(store);
  return {
    ...methodApi(async, STORE_METHODS),
    neighbors: (collection: string, opts: Parameters<typeof neighbors>[2]) =>
      neighbors(async, collection, opts),
    traverse: (collection: string, opts: Parameters<typeof traverse>[2]) =>
      traverse(async, collection, opts),
    traverseFrontierBatched: (
      collection: string,
      opts: Parameters<typeof traverseFrontierBatched>[2],
    ) => traverseFrontierBatched(async, collection, opts),
  };
}

/** The optional capability names a scenario may declare. Anything else in a
 *  scenario's `capabilities` is a corpus typo, and every runner must fail on it
 *  rather than pass a scenario whose gate nobody understands.
 *
 * Native vector engines replay the full vector contract separately. */
const KNOWN_CAPABILITIES = ["listWhereIn"] as const;

/** Optional capabilities a backend has right now. `listWhereIn` is a method both
 *  stores implement. */
export function backendCapabilities(backend: BackendName): string[] {
  return backend === "markdown" ? [] : ["listWhereIn"];
}

/** The capabilities a scenario declares that this backend cannot supply, plus
 *  any name that is not a known capability at all. Empty is the only acceptable
 *  answer: a runner FAILS on a non-empty result and names the capability. There
 *  is no skip, for the same reason `ports` has none — a skip lets a gate quietly
 *  retire a scenario instead of proving the behavior. */
export function unsupportedCapabilities(
  backend: BackendName,
  capabilities: readonly string[],
): string[] {
  const have = backendCapabilities(backend);
  const known: readonly string[] = KNOWN_CAPABILITIES;
  return capabilities.filter(
    (capability) => !known.includes(capability) || !have.includes(capability),
  );
}

export function openTarget(backend: BackendName, scenario: TargetRequest): OpenTarget {
  const kind = targetKindFor(scenario.ports);

  if (backend === "markdown" && kind === "store_markdown") return openMarkdownTarget();
  if (backend === "markdown" || kind === "store_markdown")
    throw new Error(`backend ${backend} cannot bind target ${kind}`);

  if (kind === "hash") {
    return { target: { kind, api: hashApi() }, dispose: () => {} };
  }

  if (kind === "memory_transaction") {
    if (backend !== "memory") throw new Error("Memory transaction participation requires the memory backend");
    return { target: { kind, api: memoryTransactionApi() }, dispose: () => {} };
  }

  if (kind === "coordination") {
    if (backend === "node-sqlite") throw new Error("Coordination uses its explicit SQLite source adapter.");
    let sqlite: SqliteCoordinator | undefined;
    const api = coordinationApi((clock) => {
      if (backend === "memory") return createMemoryCoordinator({ state: createMemoryCoordinationState(), clock });
      sqlite = new SqliteCoordinator({ path: ":memory:", clock });
      return sqlite;
    });
    return { target: { kind, api }, dispose: () => sqlite?.close() };
  }

  if (kind === "jobs") {
    // Source backends and built jobs carry distinct compile-time version brands.
    let now = 100;
    let token = 0;
    const clock = { now: () => now, token: () => `owner-${++token}` };
    if (backend === "memory") {
      const kv = new InMemoryKv({ versionIdentity: CONFORMANCE_VERSION_IDENTITY });
      const log = new InMemoryLogStore();
      const jobs = new JobsStore({ store: toAsync(kv) as unknown as JobsOptions["store"], transactions: createMemoryTransactions({ kv, log }), ...clock });
      return { target: { kind, api: jobsConformanceTarget(jobs, (value) => { now = value; }) }, dispose: () => {} };
    }
    const Adapter = backend === "node-sqlite" ? NodeSqliteAdapter : SqliteAdapter;
    const adapter = new Adapter({ path: ":memory:", versionIdentity: CONFORMANCE_VERSION_IDENTITY });
    const jobs = new JobsStore({ store: adapter.asyncKv as unknown as JobsOptions["store"], transactions: { transaction: (work) => adapter.asyncTransaction(work), afterCommit: (notify) => adapter.afterCommit(notify) }, ...clock });
    return { target: { kind, api: jobsConformanceTarget(jobs, (value) => { now = value; }) }, dispose: () => adapter.close() };
  }

  if (backend === "memory") {
    if (kind === "artifact") {
      const store = new InMemoryKv({ versionIdentity: CONFORMANCE_VERSION_IDENTITY });
      return { target: { kind, api: artifactApi(backend, store) }, dispose: () => {} };
    }
    if (kind === "fixtures") {
      const store = new InMemoryKv({ versionIdentity: CONFORMANCE_VERSION_IDENTITY });
      return {
        target: { kind, api: fixturesApi(store as unknown as FixturesBackendStore) },
        dispose: () => {},
      };
    }
    if (kind === "vector") {
      const store = new InMemoryVectorStore();
      return { target: { kind, api: methodApi(store, VECTOR_METHODS) }, dispose: () => {} };
    }
    if (kind === "search") {
      const store = new InMemorySearchStore();
      return { target: { kind, api: methodApi(store, SEARCH_METHODS) }, dispose: () => {} };
    }
    if (kind === "log") {
      const log = new InMemoryLogStore();
      const kv = new InMemoryKv({ versionIdentity: CONFORMANCE_VERSION_IDENTITY });
      const transactions = createMemoryTransactions({ kv, log });
      return {
        target: { kind, api: { ...logApi(log, (work) => log.transaction(work)), ...recordHistoryApi(kv, log, transactions) } },
        dispose: () => {},
      };
    }
    const setup = scenarioStoreSetup(scenario);
    const store = new InMemoryKv({ versionIdentity: CONFORMANCE_VERSION_IDENTITY, ...setup.options });
    return {
      target: {
        kind,
        api: kind === "graph" ? graphApi(store) : { ...methodApi(store, STORE_METHODS), ...setup.api },
      },
      dispose: () => {},
    };
  }

  const Adapter = backend === "node-sqlite" ? NodeSqliteAdapter : SqliteAdapter;
  const setup = scenarioStoreSetup(scenario);
  const adapter = new Adapter(
    kind === "vector"
      ? {
          path: ":memory:",
          versionIdentity: CONFORMANCE_VERSION_IDENTITY,
        }
      : { path: ":memory:", versionIdentity: CONFORMANCE_VERSION_IDENTITY, ...setup.options },
  );
  const dispose = () => adapter.close();

  if (kind === "artifact") {
    return { target: { kind, api: artifactApi(backend, adapter.kv) }, dispose };
  }

  if (kind === "fixtures") {
    return {
      target: { kind, api: fixturesApi(adapter.kv as unknown as FixturesBackendStore) },
      dispose,
    };
  }
  if (kind === "vector") {
    return { target: { kind, api: methodApi(adapter.vector, VECTOR_METHODS) }, dispose };
  }
  if (kind === "search") {
    return { target: { kind, api: methodApi(adapter.search, SEARCH_METHODS) }, dispose };
  }
  if (kind === "log") {
    return {
      target: { kind, api: { ...logApi(adapter.log, (work) => adapter.transaction(work)), ...recordHistoryApi(adapter.kv, adapter.log, { transaction: (work) => adapter.asyncTransaction(work), afterCommit: (notify) => adapter.afterCommit(notify) }) } },
      dispose,
    };
  }
  return {
    target: {
      kind,
      api:
        kind === "graph"
          ? graphApi(adapter.kv)
          : { ...methodApi(adapter.kv, STORE_METHODS), ...setup.api },
    },
    dispose,
  };
}
