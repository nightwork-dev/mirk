import type { StoreFilter, SyncStore } from "./types.js";
import type {
  AtomicMutationRequest,
  AtomicMutationResult,
  StoreCondition,
  StoreTarget,
  StoreVersion,
  SyncAtomicMutationStore,
  VersionedStoreValue,
} from "./atomic.js";
import { supportsAtomicMutation, validateAtomicRequest } from "./atomic.js";
import { AtomicMutationRejectedError } from "./atomic.js";

const SEPARATOR = "\u001f";

function assertNamespace(namespace: string): void {
  if (namespace.length === 0 || namespace.includes(SEPARATOR)) {
    throw new Error(
      "namespace must be non-empty and must not contain the unit separator"
    );
  }
}

function prefix(namespace: string, value: string): string {
  return `${namespace}${SEPARATOR}${value}`;
}

export function namespaceStore(
  store: SyncStore & SyncAtomicMutationStore,
  namespace: string
): SyncStore & SyncAtomicMutationStore;
export function namespaceStore(store: SyncStore, namespace: string): SyncStore;
export function namespaceStore(store: SyncStore, namespace: string): SyncStore {
  assertNamespace(namespace);
  const keyPrefix = prefix(namespace, "");
  const collection = (name: string): string => prefix(namespace, name);

  const result: SyncStore = {
    meta: store.meta,
    get<T>(key: string): T | null {
      return store.get<T>(prefix(namespace, key));
    },
    set<T>(key: string, value: T): void {
      store.set(prefix(namespace, key), value);
    },
    has(key: string): boolean {
      return store.has(prefix(namespace, key));
    },
    delete(key: string): boolean {
      return store.delete(prefix(namespace, key));
    },
    keys(key?: string): string[] {
      return store
        .keys(prefix(namespace, key ?? ""))
        .map((stored) => stored.slice(keyPrefix.length));
    },
    list<T>(name: string, filter?: StoreFilter): T[] {
      return store.list<T>(collection(name), filter);
    },
    getById<T>(name: string, id: string): T | null {
      return store.getById<T>(collection(name), id);
    },
    put<T extends { id: string }>(name: string, item: T): T {
      return store.put(collection(name), item);
    },
    remove(name: string, id: string): boolean {
      return store.remove(collection(name), id);
    },
    count(name: string, filter?: StoreFilter): number {
      return store.count(collection(name), filter);
    },
  };

  if (supportsAtomicMutation(store)) {
    const atomic = result as SyncStore & SyncAtomicMutationStore;
    atomic.getVersioned = <T>(
      target: StoreTarget
    ): VersionedStoreValue<T> | null => {
      const value = store.getVersioned<T>(bindTarget(target));
      if (!value) return null;
      return { value: value.value, version: bindVersion(value.version) };
    };
    atomic.mutateAtomically = (
      request: AtomicMutationRequest
    ): AtomicMutationResult => {
      // Validate before touching the request. Besides preserving typed
      // rejections for malformed input, this prevents sparse arrays or an empty
      // collection name from being transformed into a valid physical target.
      const validated = validateAtomicRequest(request);
      const bound = {
        conditions: validated.conditions.map(bindCondition),
        operations: validated.operations.map(bindOperation),
        idempotency: validated.idempotency
          ? {
              ...validated.idempotency,
              key: prefix(namespace, validated.idempotency.key),
            }
          : undefined,
      };
      const result = store.mutateAtomically(bound);
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
        return {
          ...result,
          key: result.key.slice(prefix(namespace, "").length),
        };
      }
      return {
        ...result,
        versions: result.versions.map((entry) => ({
          target: unbindTarget(entry.target),
          version: entry.version === null ? null : bindVersion(entry.version),
        })),
      };
    };
  }
  return result;

  function bindTarget(target: StoreTarget): StoreTarget {
    return target.kind === "key"
      ? { kind: "key", key: prefix(namespace, target.key) }
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

  function bindCondition(condition: StoreCondition): StoreCondition {
    if (condition.expected !== "version")
      return { ...condition, target: bindTarget(condition.target) };
    if (!isBoundVersion(condition.version)) {
      throw new AtomicMutationRejectedError(
        "invalid-request",
        "version token belongs to a different namespace"
      );
    }
    return {
      ...condition,
      target: bindTarget(condition.target),
      version: unbindVersion(condition.version),
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
        return { ...operation, key: prefix(namespace, operation.key) };
      case "delete":
        return { ...operation, key: prefix(namespace, operation.key) };
      case "put":
        return { ...operation, collection: collection(operation.collection) };
      case "remove":
        return { ...operation, collection: collection(operation.collection) };
    }
  }

  function bindVersion(version: StoreVersion): StoreVersion {
    return `${namespace}\u0000${version}` as StoreVersion;
  }

  function unbindVersion(version: StoreVersion): StoreVersion {
    return version.slice(namespace.length + 1) as StoreVersion;
  }

  function isBoundVersion(version: string): boolean {
    return version.startsWith(`${namespace}\u0000`);
  }
}
