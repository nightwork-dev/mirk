import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { ArtifactCoordinator, InMemoryObjectStore } from "@mirk/artifact";
import { StoreArtifactRepository } from "@mirk/artifact/store";
import { namespaceAsyncStore } from "@mirk/store";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PostgresAdapter } from "./postgres-adapter.js";

const connectionString = process.env.MIRK_POSTGRES_TEST_URL;
const describePostgres = connectionString ? describe : describe.skip;

// Two short-lived hosts sharing one schema: the arrangement a serverless app
// with job leases and atomic artifact finalization runs in production.
describePostgres("two hosts on one PostgreSQL schema", () => {
  const schema = `mirk_hosted_${randomUUID().replaceAll("-", "")}`;
  let hostA: PostgresAdapter;
  let hostB: PostgresAdapter;

  beforeAll(async () => {
    hostA = await PostgresAdapter.open({ connectionString, schema });
    hostB = await PostgresAdapter.open({ connectionString, schema });
  });
  afterAll(async () => {
    await hostA?.close();
    await hostB?.close();
    const pool = new Pool({ connectionString });
    await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool.end();
  });

  it("finalizes one artifact when both hosts write the same idempotent output", async () => {
    const objects = new InMemoryObjectStore();
    let n = 0;
    const coordinator = (host: PostgresAdapter) =>
      new ArtifactCoordinator(objects, new StoreArtifactRepository(host.kv, { namespace: "artifacts" }), {
        concurrency: { mode: "repository-atomic" },
        idFactory: () => `artifact-${++n}`,
      });
    const input = {
      bytes: new TextEncoder().encode("rendered"),
      mediaType: "text/plain",
      idempotencyKey: "job-1:output",
    };
    const [a, b] = await Promise.all([coordinator(hostA).write(input), coordinator(hostB).write(input)]);
    expect(a.id).toBe(b.id);
    expect((await coordinator(hostB).verify(a.id)).ok).toBe(true);
  });

  it("fences a stale lease holder and notifies only for the committed generation", async () => {
    const jobsA = namespaceAsyncStore(hostA.kv, "jobs");
    const jobsB = namespaceAsyncStore(hostB.kv, "jobs");
    await jobsA.put("leases", { id: "job-1", holder: "a", generation: 1 });
    const stale = await jobsA.getVersioned({ kind: "record", collection: "leases", id: "job-1" });

    const notified: string[] = [];
    await hostB.transaction(async () => {
      const current = await jobsB.getVersioned<{ generation: number }>({ kind: "record", collection: "leases", id: "job-1" });
      const taken = await jobsB.mutateAtomically({
        conditions: [{ target: { kind: "record", collection: "leases", id: "job-1" }, expected: "version", version: current!.version }],
        operations: [{ op: "put", collection: "leases", item: { id: "job-1", holder: "b", generation: current!.value.generation + 1 } }],
      });
      expect(taken.status).toBe("applied");
      hostB.afterCommit(() => notified.push("b took job-1"));
    });

    const fenced = await jobsA.mutateAtomically({
      conditions: [{ target: { kind: "record", collection: "leases", id: "job-1" }, expected: "version", version: stale!.version }],
      operations: [{ op: "put", collection: "leases", item: { id: "job-1", holder: "a", generation: 2, done: true } }],
    });
    expect(fenced.status).toBe("conflict");
    expect(notified).toEqual(["b took job-1"]);
    expect(await jobsA.getById("leases", "job-1")).toEqual({ id: "job-1", holder: "b", generation: 2 });
  });
});
