import type { AsyncStore, StoreFilter, SyncStore } from "./types.js";
import type {
  AtomicMutationRequest,
  AtomicMutationResult,
  StoreCondition,
  StoreTarget,
  StoreVersion,
  AsyncAtomicMutationStore,
  AtomicMutationLimits,
  SyncAtomicMutationStore,
  VersionedStoreValue,
} from "./atomic.js";
import {
  supportsAsyncAtomicMutation,
  supportsAtomicMutation,
  validateAtomicRequest,
} from "./atomic.js";
import { AtomicMutationRejectedError } from "./atomic.js";

const SEPARATOR = "\u001f";

export type NamespaceErrorCode = "invalid-namespace";

/** Thrown for an empty namespace or one containing the unit separator. */
export class NamespaceError extends Error {
  declare readonly name: "NamespaceError";
  constructor(readonly code: NamespaceErrorCode, message: string) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
Object.defineProperty(NamespaceError.prototype, "name", {
  value: "NamespaceError",
  writable: true,
  configurable: true,
  enumerable: false,
});

function assertNamespace(namespace: string): void {
  if (namespace.length === 0 || namespace.includes(SEPARATOR)) {
    throw new NamespaceError(
      "invalid-namespace",
      "namespace must be non-empty and must not contain the unit separator"
    );
  }
}

function prefix(namespace: string, value: string): string {
  return `${namespace}${SEPARATOR}${value}`;
}

/** The key, collection, target and version-token mapping one namespace
 *  applies. The sync and async bindings share it, so both produce the same
 *  physical rows and the same namespaced version tokens. */
function namespaceBinding(namespace: string) {
  assertNamespace(namespace);
  const keyPrefix = prefix(namespace, "");
  const key = (value: string): string => prefix(namespace, value);
  const collection = (name: string): string => prefix(namespace, name);
  const versionPrefix = `${namespace}\u0000`;

  function bindTarget(target: StoreTarget): StoreTarget {
    return target.kind === "key"
      ? { kind: "key", key: key(target.key) }
      : {
          kind: "record",
          collection: collection(target.collection),
          id: target.id,
        };
  }

  function unbindTarget(target: StoreTarget): StoreTarget {
    return target.kind === "key"
      ? { kind: "key", key: target.key.slice(keyPrefix.length) }
      : {
          kind: "record",
          collection: target.collection.slice(keyPrefix.length),
          id: target.id,
        };
  }

  function bindVersion(version: StoreVersion): StoreVersion {
    return `${versionPrefix}${version}` as StoreVersion;
  }

  function bindCondition(condition: StoreCondition): StoreCondition {
    if (condition.expected !== "version")
      return { ...condition, target: bindTarget(condition.target) };
    if (!condition.version.startsWith(versionPrefix)) {
      throw new AtomicMutationRejectedError(
        "invalid-request",
        "version token belongs to a different namespace"
      );
    }
    return {
      ...condition,
      target: bindTarget(condition.target),
      version: condition.version.slice(versionPrefix.length) as StoreVersion,
    };
  }

  function unbindCondition(condition: StoreCondition): StoreCondition {
    if (condition.expected !== "version")
      return { ...condition, target: unbindTarget(condition.target) };
    return {
      ...condition,
      target: unbindTarget(condition.target),
      version: bindVersion(condition.version),
    };
  }

  function bindOperation(
    operation: AtomicMutationRequest["operations"][number]
  ): AtomicMutationRequest["operations"][number] {
    switch (operation.op) {
      case "set":
      case "delete":
        return { ...operation, key: key(operation.key) };
      case "put":
      case "remove":
        return { ...operation, collection: collection(operation.collection) };
    }
  }

  return {
    key,
    collection,
    unbindKey: (stored: string): string => stored.slice(keyPrefix.length),
    bindTarget,
    bindVersioned<T>(
      value: VersionedStoreValue<T> | null
    ): VersionedStoreValue<T> | null {
      return value ? { value: value.value, version: bindVersion(value.version) } : null;
    },
    /** Validate before touching the request. Besides preserving typed
     *  rejections for malformed input, this prevents sparse arrays or an empty
     *  collection name from being transformed into a valid physical target. */
    bindRequest(
      request: AtomicMutationRequest,
      limits: AtomicMutationLimits
    ): AtomicMutationRequest {
      const validated = validateAtomicRequest(request, limits);
      return {
        conditions: validated.conditions.map(bindCondition),
        operations: validated.operations.map(bindOperation),
        idempotency: validated.idempotency
          ? { ...validated.idempotency, key: key(validated.idempotency.key) }
          : undefined,
      };
    },
    unbindResult(result: AtomicMutationResult): AtomicMutationResult {
      if (result.status === "conflict") {
        return {
          ...result,
          condition: unbindCondition(result.condition),
          observed:
            result.observed === "missing" || result.observed === "present"
              ? result.observed
              : bindVersion(result.observed),
        };
      }
      if (result.status === "idempotency-conflict") {
        return { ...result, key: result.key.slice(keyPrefix.length) };
      }
      return {
        ...result,
        versions: result.versions.map((entry) => ({
          target: unbindTarget(entry.target),
          version: entry.version === null ? null : bindVersion(entry.version),
        })),
      };
    },
  };
}

type Writable<T> = { -readonly [K in keyof T]: T[K] };

export function namespaceStore(
  store: SyncStore & SyncAtomicMutationStore,
  namespace: string
): SyncStore & SyncAtomicMutationStore;
export function namespaceStore(store: SyncStore, namespace: string): SyncStore;
export function namespaceStore(store: SyncStore, namespace: string): SyncStore {
  const ns = namespaceBinding(namespace);
  const result: SyncStore = {
    meta: store.meta,
    get: <T>(key: string): T | null => store.get<T>(ns.key(key)),
    set: <T>(key: string, value: T): void => store.set(ns.key(key), value),
    has: (key: string): boolean => store.has(ns.key(key)),
    delete: (key: string): boolean => store.delete(ns.key(key)),
    keys: (key?: string): string[] =>
      store.keys(ns.key(key ?? "")).map(ns.unbindKey),
    list: <T>(name: string, filter?: StoreFilter): T[] =>
      store.list<T>(ns.collection(name), filter),
    getById: <T>(name: string, id: string): T | null =>
      store.getById<T>(ns.collection(name), id),
    put: <T extends { id: string }>(name: string, item: T): T =>
      store.put(ns.collection(name), item),
    remove: (name: string, id: string): boolean =>
      store.remove(ns.collection(name), id),
    count: (name: string, filter?: StoreFilter): number =>
      store.count(ns.collection(name), filter),
  };

  if (supportsAtomicMutation(store)) {
    const atomic = result as SyncStore & Writable<SyncAtomicMutationStore>;
    // A namespaced handle is a binding, not a backend: it enforces exactly what
    // the store underneath it enforces.
    atomic.atomicLimits = store.atomicLimits;
    atomic.getVersioned = <T>(target: StoreTarget) =>
      ns.bindVersioned(store.getVersioned<T>(ns.bindTarget(target)));
    atomic.mutateAtomically = (request: AtomicMutationRequest) =>
      ns.unbindResult(
        store.mutateAtomically(ns.bindRequest(request, store.atomicLimits))
      );
  }
  return result;
}

/** The awaitable twin of {@link namespaceStore}: the same physical keys,
 *  collections and namespaced version tokens over an {@link AsyncStore}. */
export function namespaceAsyncStore(
  store: AsyncStore & AsyncAtomicMutationStore,
  namespace: string
): AsyncStore & AsyncAtomicMutationStore;
export function namespaceAsyncStore(
  store: AsyncStore,
  namespace: string
): AsyncStore;
export function namespaceAsyncStore(
  store: AsyncStore,
  namespace: string
): AsyncStore {
  const ns = namespaceBinding(namespace);
  const result: AsyncStore = {
    meta: store.meta,
    get: <T>(key: string): Promise<T | null> => store.get<T>(ns.key(key)),
    set: <T>(key: string, value: T): Promise<void> =>
      store.set(ns.key(key), value),
    has: (key: string): Promise<boolean> => store.has(ns.key(key)),
    delete: (key: string): Promise<boolean> => store.delete(ns.key(key)),
    keys: async (key?: string): Promise<string[]> =>
      (await store.keys(ns.key(key ?? ""))).map(ns.unbindKey),
    list: <T>(name: string, filter?: StoreFilter): Promise<T[]> =>
      store.list<T>(ns.collection(name), filter),
    getById: <T>(name: string, id: string): Promise<T | null> =>
      store.getById<T>(ns.collection(name), id),
    put: <T extends { id: string }>(name: string, item: T): Promise<T> =>
      store.put(ns.collection(name), item),
    remove: (name: string, id: string): Promise<boolean> =>
      store.remove(ns.collection(name), id),
    count: (name: string, filter?: StoreFilter): Promise<number> =>
      store.count(ns.collection(name), filter),
  };

  if (supportsAsyncAtomicMutation(store)) {
    const atomic = result as AsyncStore & Writable<AsyncAtomicMutationStore>;
    atomic.atomicLimits = store.atomicLimits;
    atomic.getVersioned = async <T>(target: StoreTarget) =>
      ns.bindVersioned(await store.getVersioned<T>(ns.bindTarget(target)));
    atomic.mutateAtomically = async (request: AtomicMutationRequest) => {
      const bound = ns.bindRequest(request, store.atomicLimits);
      return ns.unbindResult(await store.mutateAtomically(bound));
    };
  }
  return result;
}
