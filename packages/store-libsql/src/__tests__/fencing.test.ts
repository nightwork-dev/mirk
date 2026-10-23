// Two hosts on one database fence each other with a lease held as a versioned
// record. These are the store-level properties a job runner builds leases and
// stale-generation fencing on: a stale edit conflicts, a promotion inside
// transaction() commits only while its lease generation is current, an
// unexpired lease is joined, and an expired one is taken over exactly once.

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { StoreVersion } from "@mirk/store";

import {
  dropTables,
  fileTarget,
  runPrefix,
  sqldBinary,
  sqldTarget,
  startSqld,
  tursoConnection,
  tursoTarget,
  type Adapter,
  type Sqld,
  type Target,
} from "./targets.js";

type Lease = {
  id: string;
  owner: string;
  generation: number;
  expiresAt: number;
};

interface Held {
  lease: Lease;
  version: StoreVersion;
}

const LEASES = "leases";
const target = (id: string) => ({ kind: "record" as const, collection: LEASES, id });

class StaleGeneration extends Error {}

/** Take the job's lease unless another owner holds an unexpired one. */
async function acquire(host: Adapter, job: string, owner: string, now: number, ttl = 60_000): Promise<Held | "held"> {
  return host.transaction(async () => {
    const current = await host.kv.getVersioned<Lease>(target(job));
    if (current && current.value.expiresAt > now && current.value.owner !== owner) return "held";
    const lease: Lease = {
      id: job,
      owner,
      generation: (current?.value.generation ?? 0) + 1,
      expiresAt: now + ttl,
    };
    const result = await host.kv.mutateAtomically({
      conditions: [
        current
          ? { target: target(job), expected: "version", version: current.version }
          : { target: target(job), expected: "missing" },
      ],
      operations: [{ op: "put", collection: LEASES, item: lease }],
    });
    if (result.status !== "applied") return "held";
    return { lease, version: result.versions[0]!.version! };
  });
}

/** Write the job's results and mark it done, only while `held` is current. */
async function promote(host: Adapter, held: Held, results: string[]): Promise<void> {
  await host.transaction(async () => {
    for (const result of results) {
      await host.kv.put("results", { id: result, job: held.lease.id, generation: held.lease.generation });
    }
    const fenced = await host.kv.mutateAtomically({
      conditions: [{ target: target(held.lease.id), expected: "version", version: held.version }],
      operations: [{ op: "set", key: `done/${held.lease.id}`, value: { generation: held.lease.generation } }],
    });
    if (fenced.status !== "applied") throw new StaleGeneration(`lease ${held.lease.id} was replaced`);
  });
}

function fencing(make: () => Target): void {
  async function hosts(work: (a: Adapter, b: Adapter) => Promise<void>): Promise<void> {
    const database = await make().fresh();
    try {
      await work(await database.open(), await database.open());
    } finally {
      await database.dispose();
    }
  }

  it("rejects a stale edit after another host changed the record", () =>
    hosts(async (a, b) => {
      await a.kv.put("cases", { id: "c1", trustee: "original" });
      const seenByA = await a.kv.getVersioned({ kind: "record", collection: "cases", id: "c1" });
      await b.kv.put("cases", { id: "c1", trustee: "edited on b" });
      const stale = await a.kv.mutateAtomically({
        conditions: [{ target: { kind: "record", collection: "cases", id: "c1" }, expected: "version", version: seenByA!.version }],
        operations: [{ op: "put", collection: "cases", item: { id: "c1", trustee: "stale host" } }],
      });
      expect(stale.status).toBe("conflict");
      expect(await a.kv.getById("cases", "c1")).toEqual({ id: "c1", trustee: "edited on b" });
    }));

  it("fences a promotion once another host replaced the lease generation, and lets the new generation complete", () =>
    hosts(async (a, b) => {
      const now = Date.now();
      const old = await acquire(a, "job", "a", now, 1);
      expect(old).not.toBe("held");
      const taken = await acquire(b, "job", "b", now + 10);
      expect(taken).not.toBe("held");
      if (old === "held" || taken === "held") return;
      expect(taken.lease.generation).toBe(old.lease.generation + 1);

      await expect(promote(a, old, ["a-1", "a-2"])).rejects.toBeInstanceOf(StaleGeneration);
      expect(await b.kv.getById("results", "a-1")).toBeNull();
      expect(await b.kv.getById("results", "a-2")).toBeNull();
      expect(await b.kv.get("done/job")).toBeNull();

      await promote(b, taken, ["b-1"]);
      expect(await a.kv.get("done/job")).toEqual({ generation: 2 });
      expect(await a.kv.getById("results", "b-1")).toEqual({ id: "b-1", job: "job", generation: 2 });
    }));

  it("fences a promotion whose lease is revoked while the promotion waits for the write lock", () =>
    hosts(async (a, b) => {
      const held = await acquire(a, "job", "a", Date.now());
      if (held === "held") throw new Error("expected the lease");
      let revoked!: () => void;
      const revoking = new Promise<void>((resolve) => (revoked = resolve));
      const release = { open: () => {} };
      const holding = new Promise<void>((resolve) => (release.open = resolve));
      const revocation = b.transaction(async () => {
        const current = await b.kv.getVersioned<Lease>(target("job"));
        await b.kv.put(LEASES, { ...current!.value, owner: "cancelled", expiresAt: 0 });
        revoked();
        await holding;
      });
      await revoking;
      const promotion = promote(a, held, ["late"]);
      release.open();
      await revocation;
      await expect(promotion).rejects.toBeInstanceOf(StaleGeneration);
      expect(await b.kv.getById("results", "late")).toBeNull();
    }));

  it("joins an unexpired lease and takes over an expired one exactly once", () =>
    hosts(async (a, b) => {
      const now = Date.now();
      const first = await acquire(a, "refresh", "a", now, 1_000);
      expect(first).not.toBe("held");
      expect(await acquire(b, "refresh", "b", now + 500)).toBe("held");

      const later = now + 5_000;
      const contenders = await Promise.all([
        acquire(a, "refresh", "c", later),
        acquire(b, "refresh", "d", later),
      ]);
      const winners = contenders.filter((result): result is Held => result !== "held");
      expect(winners).toHaveLength(1);
      expect(winners[0]!.lease.generation).toBe(2);
      const current = await a.kv.getVersioned<Lease>(target("refresh"));
      expect(current?.version).toBe(winners[0]!.version);
      if (first !== "held") await expect(promote(a, first, [])).rejects.toBeInstanceOf(StaleGeneration);
    }));

  it("keeps a committed promotion and its receipt for the host that reconciles an expired owner", () =>
    hosts(async (a, b) => {
      const held = await acquire(a, "verify", "a", Date.now(), 1);
      if (held === "held") throw new Error("expected the lease");
      const request = {
        conditions: [{ target: target("verify"), expected: "version" as const, version: held.version }],
        operations: [{ op: "put" as const, collection: "receipts", item: { id: "verify", status: "exported" } }],
        idempotency: { key: "verify/promotion", outcome: { committed: true } },
      };
      const applied = await a.kv.mutateAtomically(request);
      expect(applied.status).toBe("applied");

      const taken = await acquire(b, "verify", "b", Date.now() + 10);
      expect(taken).not.toBe("held");
      const replayed = await b.kv.mutateAtomically(request);
      expect(replayed).toMatchObject({ status: "replayed", outcome: { committed: true } });
      expect(await b.kv.getById("receipts", "verify")).toEqual({ id: "verify", status: "exported" });
    }));
}

describe("libSQL file: lease fencing across two adapters", { timeout: 30_000 }, () => fencing(fileTarget));

describe.runIf(sqldBinary)("libSQL sqld lease fencing across two adapters", { timeout: 60_000 }, () => {
  let server: Sqld;
  beforeAll(async () => {
    server = await startSqld(sqldBinary!);
  });
  afterAll(async () => {
    await server?.stop();
  });
  fencing(() => sqldTarget(() => server));
});

describe.runIf(tursoConnection)("libSQL Turso lease fencing across two adapters", { timeout: 120_000 }, () => {
  afterAll(async () => {
    await dropTables(tursoConnection!, runPrefix);
  });
  fencing(tursoTarget);
});
