// Type-level tests for caller-owned record types in atomic requests. The
// `@ts-expect-error` lines fail `pnpm -r typecheck` if a value TypeScript can
// see is not JSON stops being refused.

import { describe, expect, expectTypeOf, it } from "vitest";

import {
  atomicPut,
  atomicSet,
  jsonValue,
  type AsyncAtomicStore,
  type AtomicMutationRequest,
  type AtomicStoreOperation,
  type JsonCompatible,
  type JsonValue,
  type SyncAtomicStore,
} from "./index.js";
import type { AsyncAtomicMutationStore, SyncAtomicMutationStore } from "./atomic.js";
import type { AsyncStore, SyncStore } from "./types.js";
import { InMemoryKv } from "./index.js";

interface Grant {
  accountId: string;
  access: Array<"read" | "write">;
  expiresAt: number;
  note?: string;
  scope: { vaultId: string; objectIds: readonly string[] };
  revoked: boolean | null;
}

interface Claim {
  id: string;
  sensitivity: "low" | "high";
  parentId?: string;
}

type Envelope = { iv: string; data: string };

class WithMethod {
  constructor(readonly at: number) {}
  describe(): string {
    return String(this.at);
  }
}

const grant: Grant = {
  accountId: "a",
  access: ["read"],
  expiresAt: 1,
  scope: { vaultId: "v", objectIds: [] },
  revoked: null,
};

describe("caller record types in atomic requests", () => {
  it("names the combined store types", () => {
    expectTypeOf<SyncAtomicStore>().toEqualTypeOf<SyncStore & SyncAtomicMutationStore>();
    expectTypeOf<AsyncAtomicStore>().toEqualTypeOf<AsyncStore & AsyncAtomicMutationStore>();
    const store: SyncAtomicStore = new InMemoryKv();
    expect(store.atomicLimits.maxOperations).toBeGreaterThan(0);
  });

  it("an interface is not a JsonValue, which is why callers cast", () => {
    // @ts-expect-error an interface has no index signature
    const value: JsonValue = grant;
    expect(value).toBe(grant);
  });

  it("accepts interfaces, optional fields and nested arrays without a cast", () => {
    const claim: Claim = { id: "x", sensitivity: "low" };
    const envelope: Envelope = { iv: "i", data: "d" };
    const request: AtomicMutationRequest = {
      operations: [
        atomicSet("grant", grant),
        atomicSet("envelope", envelope),
        atomicSet("list", [grant, grant]),
        atomicSet("scalar", 3),
        atomicPut("claims", claim),
      ],
      idempotency: { key: "k", outcome: jsonValue(grant) },
    };
    expectTypeOf(atomicSet("grant", grant)).toEqualTypeOf<AtomicStoreOperation>();
    expectTypeOf<JsonCompatible<Grant>>().toMatchTypeOf<object>();

    const store = new InMemoryKv();
    const result = store.mutateAtomically(request);
    expect(result.status).toBe("applied");
    expect(store.get<Grant>("grant")).toEqual(grant);
    expect(store.getById<Claim>("claims", "x")).toEqual(claim);
  });

  it("still refuses what TypeScript can see is not JSON", () => {
    // @ts-expect-error a function
    atomicSet("f", () => 1);
    // @ts-expect-error a method on an object
    atomicSet("m", { id: "x", run() {} });
    // @ts-expect-error a class instance with methods
    atomicSet("c", new WithMethod(1));
    // @ts-expect-error a Date
    atomicSet("d", new Date(0));
    // @ts-expect-error a Map
    atomicSet("map", new Map<string, string>());
    // @ts-expect-error a symbol
    atomicSet("s", Symbol("s"));
    // @ts-expect-error a bigint
    atomicSet("b", 1n);
    // @ts-expect-error undefined
    atomicSet("u", undefined);
    // @ts-expect-error a symbol-keyed property
    atomicSet("k", { [Symbol.iterator]: 1 });
    // @ts-expect-error a required property that may be undefined
    atomicSet("r", { a: undefined as string | undefined });
    // @ts-expect-error a value typed unknown is not known to be JSON
    atomicSet("x", { wrapped: {} as Record<string, unknown> });
    // @ts-expect-error a nested function
    jsonValue({ deep: [{ run: () => 1 }] });
    // @ts-expect-error a record without a string id
    atomicPut("c", { id: 1 });
    // @ts-expect-error a record with a method
    atomicPut("c", { id: "x", at: new Date(0) });
    expect(true).toBe(true);
  });
});
