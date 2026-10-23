// Every request a remote adapter sends is a network round trip. An atomic
// mutation must cost the same small number of them however many operations
// and conditions it carries.

import { randomUUID } from "node:crypto";

import { createClient, type Client } from "@libsql/client/web";
import type { AtomicMutationRequest, StoreVersion } from "@mirk/store";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { LibsqlAdapter } from "../remote.js";
import {
  dropTables,
  runPrefix,
  sqldBinary,
  startSqld,
  tursoConnection,
  type Sqld,
} from "./targets.js";

/** A client that counts the requests it sends. Opening a transaction stream
 *  sends nothing; its first statement carries the BEGIN. */
function counting(client: Client): { client: Client; requests: () => number } {
  let requests = 0;
  const counted = <T extends object>(target: T, methods: string[]): T =>
    new Proxy(target, {
      get(object, prop) {
        const value = Reflect.get(object, prop, object) as unknown;
        if (typeof value !== "function") return value;
        if (methods.includes(String(prop))) {
          return (...args: unknown[]) => {
            requests += 1;
            return (value as (...a: unknown[]) => unknown).apply(object, args);
          };
        }
        if (prop === "transaction") {
          return async (...args: unknown[]) =>
            counted(
              await (value as (...a: unknown[]) => Promise<object>).apply(object, args),
              ["execute", "batch", "commit", "rollback"],
            );
        }
        return (value as (...a: unknown[]) => unknown).bind(object);
      },
    });
  return { client: counted(client, ["execute", "batch", "executeMultiple"]), requests: () => requests };
}

const SIZES = [1, 10, 100];
const MAX_REQUESTS = 6;

function roundTrips(name: string, connection: () => { url: string; authToken?: string }): void {
  let sequence = 0;

  async function open(tablePrefix: string) {
    const raw = createClient(connection());
    const { client, requests } = counting(raw);
    const adapter = await LibsqlAdapter.open({ ...connection(), client, tablePrefix });
    return {
      adapter,
      requests,
      close: () => {
        adapter.close();
        raw.close();
      },
    };
  }

  async function cost(
    prefix: string,
    request: (n: number) => AtomicMutationRequest,
    prepare?: (adapter: LibsqlAdapter, n: number) => Promise<void>,
  ): Promise<number[]> {
    const counts: number[] = [];
    for (const n of SIZES) {
      const store = await open(prefix);
      try {
        await prepare?.(store.adapter, n);
        const before = store.requests();
        const result = await store.adapter.kv.mutateAtomically(request(n));
        counts.push(store.requests() - before);
        expect(result.status).toBe("applied");
      } finally {
        store.close();
      }
    }
    return counts;
  }

  const puts = (collection: string, n: number) =>
    Array.from({ length: n }, (_, i) => ({ op: "put" as const, collection, item: { id: `r${i}`, i } }));

  describe(`atomic mutation round trips on ${name}`, () => {
    it("puts into a collection the adapter has not used cost the same at every size", async () => {
      const prefix = `${runPrefix}rt${++sequence}_`;
      const seeded = await open(prefix);
      await seeded.adapter.kv.put("existing", { id: "seed" });
      seeded.close();
      const counts = await cost(prefix, (n) => ({ operations: puts("existing", n) }));
      expect(Math.max(...counts)).toBeLessThanOrEqual(MAX_REQUESTS);
      expect(counts).toEqual(counts.map(() => counts[0]));
    });

    it("conditions on every target and an idempotency key cost the same at every size", async () => {
      const prefix = `${runPrefix}rt${++sequence}_`;
      const versions = new Map<number, StoreVersion[]>();
      const counts = await cost(
        prefix,
        (n) => ({
          conditions: versions.get(n)!.map((version, i) => ({
            target: { kind: "record" as const, collection: `c${n}`, id: `r${i}` },
            expected: "version" as const,
            version,
          })),
          operations: [...puts(`c${n}`, n), { op: "delete" as const, key: `k${n}` }],
          idempotency: { key: randomUUID() },
        }),
        async (adapter, n) => {
          const seeded = await adapter.kv.mutateAtomically({ operations: puts(`c${n}`, n) });
          if (seeded.status !== "applied") throw new Error("seed failed");
          versions.set(n, seeded.versions.map((v) => v.version!));
        },
      );
      expect(Math.max(...counts)).toBeLessThanOrEqual(MAX_REQUESTS);
      expect(counts).toEqual(counts.map(() => counts[0]));
    });

    it("puts into a new collection cost the same at every size", async () => {
      const prefix = `${runPrefix}rt${++sequence}_`;
      const counts = await cost(prefix, (n) => ({ operations: puts(`fresh${n}`, n) }));
      expect(counts).toEqual(counts.map(() => counts[0]));
    });
  });
}

describe.runIf(sqldBinary)("sqld", { timeout: 60_000 }, () => {
  let server: Sqld;
  beforeAll(async () => {
    server = await startSqld(sqldBinary!);
  });
  afterAll(async () => {
    await server?.stop();
  });
  roundTrips("sqld", () => ({ url: server.url }));
});

describe.runIf(tursoConnection)("Turso", { timeout: 300_000 }, () => {
  afterAll(async () => {
    await dropTables(tursoConnection!, runPrefix);
  });
  roundTrips("Turso", () => tursoConnection!);
});
