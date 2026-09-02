// ─── Conformance backend targets ────────────────────────────────────────────
// The one module in src/conformance that touches a native binding: it builds a
// live target per backend for a scenario. It is TOOLING, not a package entry
// point — it is absent from the tsup build list and from package.json exports,
// exactly like src/sqlite-harness.ts, so no consumer can import it and drag
// better-sqlite3 into a client build.
//
// Every SQLite target opens `:memory:`, so a scenario never sees another
// scenario's rows.

import { InMemoryKv, InMemorySearchStore, InMemoryVectorStore, toAsync } from "../index.js";
import { SqliteAdapter } from "../adapters/sqlite.js";
import { neighbors, traverse, traverseFrontierBatched } from "../graph.js";
import {
  targetKindFor,
  vectorDimensionsFor,
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
] as const;

const VECTOR_METHODS = ["upsert", "upsertMany", "get", "has", "remove", "count", "search"] as const;

const SEARCH_METHODS = ["index", "indexMany", "remove", "search"] as const;

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
 *  `vec0` is not a capability and never will be: roadmap MR-22 deleted the vec0
 *  path from the SQLite adapter after it was shown never to execute
 *  (docs/evidence/python-port/2026-09-02-vec0-branch-dead.md). There is no
 *  accelerated path left to gate a scenario on. */
export const KNOWN_CAPABILITIES = ["listWhereIn"] as const;

/** Optional capabilities a backend has right now. `listWhereIn` is a method both
 *  stores implement. */
export function backendCapabilities(_backend: BackendName): string[] {
  return ["listWhereIn"];
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

  if (backend === "memory") {
    if (kind === "vector") {
      const store = new InMemoryVectorStore({ dimensions: vectorDimensionsFor(scenario.steps) });
      return { target: { kind, api: methodApi(store, VECTOR_METHODS) }, dispose: () => {} };
    }
    if (kind === "search") {
      const store = new InMemorySearchStore();
      return { target: { kind, api: methodApi(store, SEARCH_METHODS) }, dispose: () => {} };
    }
    const store = new InMemoryKv();
    return {
      target: { kind, api: kind === "graph" ? graphApi(store) : methodApi(store, STORE_METHODS) },
      dispose: () => {},
    };
  }

  const adapter = new SqliteAdapter(
    kind === "vector"
      ? { path: ":memory:", dimensions: vectorDimensionsFor(scenario.steps) }
      : { path: ":memory:" },
  );
  const dispose = () => adapter.close();

  if (kind === "vector") {
    return { target: { kind, api: methodApi(adapter.vector, VECTOR_METHODS) }, dispose };
  }
  if (kind === "search") {
    return { target: { kind, api: methodApi(adapter.search, SEARCH_METHODS) }, dispose };
  }
  return {
    target: {
      kind,
      api: kind === "graph" ? graphApi(adapter.kv) : methodApi(adapter.kv, STORE_METHODS),
    },
    dispose,
  };
}
