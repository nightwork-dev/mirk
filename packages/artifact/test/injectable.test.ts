import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryKv, toAsync } from "@mirk/store/kv";
import { afterEach, describe, expect, it } from "vitest";

import {
  ArtifactCoordinator,
  ArtifactMaintenance,
  InMemoryArtifactRepository,
  InMemoryObjectStore,
} from "../src/index.js";
import type { ArtifactLeaseResult } from "../src/index.js";
import { FileObjectStore } from "../src/fs.js";
import { StoreArtifactRepository } from "../src/store.js";

const bytes = (value: string) => new TextEncoder().encode(value);

// Keys/ids whose ICU collation order and Unicode code point order disagree:
// ICU (en) sorts roughly "a" < "B" < "_" < "ä"; code point order is
// "B" (0x42) < "_" (0x5F) < "a" (0x61) < "ä" (0xE4).
const DISCRIMINATING_KEYS = ["a", "B", "_", "ä"] as const;
const CODE_POINT_ORDER = ["B", "_", "a", "ä"];

/** Captures the ownerId passed to acquireObjectLease so tests can observe an
 *  otherwise-internal injected value. */
class OwnerCapturingRepository extends InMemoryArtifactRepository {
  capturedOwnerIds: string[] = [];
  override async acquireObjectLease(
    input: Parameters<InMemoryArtifactRepository["acquireObjectLease"]>[0]
  ): Promise<ArtifactLeaseResult> {
    this.capturedOwnerIds.push(input.ownerId);
    return super.acquireObjectLease(input);
  }
}

describe("§14.1 / §14.4 ruling 5 — code point order, not locale order", () => {
  it("InMemoryObjectStore.list sorts keys by Unicode code point", async () => {
    const store = new InMemoryObjectStore();
    for (const key of DISCRIMINATING_KEYS) await store.put(key, bytes("x"));
    const listed = await store.list();
    expect(listed.map((info) => info.key)).toEqual(CODE_POINT_ORDER);
  });

  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(
      roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))
    );
  });

  it("FileObjectStore.list sorts keys by Unicode code point", async () => {
    const root = await mkdtemp(join(tmpdir(), "mirk-artifact-fs-order-"));
    roots.push(root);
    const store = new FileObjectStore({ root });
    for (const key of DISCRIMINATING_KEYS) await store.put(key, bytes("x"));
    const listed = await store.list();
    expect(listed.map((info) => info.key)).toEqual(CODE_POINT_ORDER);
  });

  it("compareRecords tie-breaks by descending code point id, not locale order", async () => {
    const repository = new InMemoryArtifactRepository();
    for (const id of DISCRIMINATING_KEYS)
      await repository.create({
        id,
        objectKey: `objects/${id}`,
        createdAt: 100,
        digest: { algorithm: "sha256", value: "0".repeat(64) },
        sizeBytes: 0,
        mediaType: "text/plain",
      });
    const page = await repository.list();
    // Same createdAt for every record, so the whole order is the id
    // tie-break: descending Unicode code point.
    expect(page.items.map((item) => item.id)).toEqual(
      [...CODE_POINT_ORDER].reverse()
    );
  });

  it("StoreArtifactRepository pages identically to InMemoryArtifactRepository for the same records", async () => {
    const memory = new InMemoryArtifactRepository();
    const storeBacked = new StoreArtifactRepository(toAsync(new InMemoryKv()));
    for (const id of DISCRIMINATING_KEYS) {
      const record = {
        id,
        objectKey: `objects/${id}`,
        createdAt: 100,
        digest: { algorithm: "sha256" as const, value: "0".repeat(64) },
        sizeBytes: 0,
        mediaType: "text/plain",
      };
      await memory.create(record);
      await storeBacked.create(record);
    }
    const memoryPage = await memory.list();
    const storePage = await storeBacked.list();
    expect(storePage.items.map((item) => item.id)).toEqual(
      memoryPage.items.map((item) => item.id)
    );
    expect(memoryPage.items.map((item) => item.id)).toEqual(
      [...CODE_POINT_ORDER].reverse()
    );
  });
});

describe("§14.4 ruling — addLineage validation order (endpoints before cycle)", () => {
  it("reports missing endpoints, not a cycle, for a self-edge with no record on either repository", async () => {
    const memory = new InMemoryArtifactRepository();
    const storeBacked = new StoreArtifactRepository(toAsync(new InMemoryKv()));
    const edge = {
      id: "edge-1",
      sourceArtifactId: "ghost",
      resultArtifactId: "ghost",
      operation: "noop",
      createdAt: 1,
    };
    // Self-edge (source === result) is a cycle by definition (§5.4), AND
    // neither endpoint exists as a record. The store order (duplicate ->
    // endpoints -> cycle) reports the endpoints error first; that is the
    // order memory must now match too.
    await expect(memory.addLineage(edge)).rejects.toThrow(
      "lineage endpoints must exist"
    );
    await expect(storeBacked.addLineage(edge)).rejects.toThrow(
      "lineage endpoints must exist"
    );
  });
});

describe("§10 injection points — table verification", () => {
  it("coordinator: createdAt (options.now) appears on the record and its lineage edge", async () => {
    let n = 0;
    const repository = new InMemoryArtifactRepository();
    const coordinator = new ArtifactCoordinator(
      new InMemoryObjectStore(),
      repository,
      { idFactory: () => `id-${++n}`, now: () => 4242 }
    );
    const source = await coordinator.write({
      bytes: bytes("source"),
      mediaType: "text/plain",
    });
    expect(source.createdAt).toBe(4242);
    const result = await coordinator.write({
      bytes: bytes("result"),
      mediaType: "text/plain",
      sources: [{ artifactId: source.id, operation: "text.transform" }],
    });
    expect(result.createdAt).toBe(4242);
    const [edge] = await repository.getSources(result.id);
    expect(edge!.createdAt).toBe(4242);
  });

  it("coordinator: idFactory supplies both the artifact id and the lineage edge id", async () => {
    const ids = ["source-id", "result-id", "edge-id"];
    let n = 0;
    const repository = new InMemoryArtifactRepository();
    const coordinator = new ArtifactCoordinator(
      new InMemoryObjectStore(),
      repository,
      { idFactory: () => ids[n++]! }
    );
    const source = await coordinator.write({
      bytes: bytes("source"),
      mediaType: "text/plain",
    });
    expect(source.id).toBe("source-id");
    const result = await coordinator.write({
      bytes: bytes("result"),
      mediaType: "text/plain",
      sources: [{ artifactId: source.id, operation: "text.transform" }],
    });
    expect(result.id).toBe("result-id");
    const [edge] = await repository.getSources(result.id);
    expect(edge!.id).toBe("edge-id");
  });

  it("coordinator: options.ownerId is the ownerId used to acquire the object lease", async () => {
    const repository = new OwnerCapturingRepository();
    const coordinator = new ArtifactCoordinator(
      new InMemoryObjectStore(),
      repository,
      { ownerId: "custom-coordinator-owner" }
    );
    await coordinator.write({ bytes: bytes("x"), mediaType: "text/plain" });
    expect(repository.capturedOwnerIds).toContain("custom-coordinator-owner");
  });

  it("maintenance: options.ownerId is the ownerId used to acquire the repair lease", async () => {
    const objects = new InMemoryObjectStore();
    await objects.put("orphan-key", bytes("orphan"));
    const repository = new OwnerCapturingRepository();
    const maintenance = new ArtifactMaintenance(objects, repository, {
      ownerId: "custom-maintenance-owner",
    });
    const report = await maintenance.audit();
    const plan = await maintenance.planRepair(report);
    expect(plan.actions).toHaveLength(1);
    await maintenance.applyRepair(plan);
    expect(repository.capturedOwnerIds).toContain("custom-maintenance-owner");
  });

  it("maintenance: auditIdFactory (newly injectable) sets report.auditId and is embedded in repair action ids", async () => {
    const objects = new InMemoryObjectStore();
    await objects.put("orphan-key", bytes("orphan"));
    const repository = new InMemoryArtifactRepository();

    const maintenanceA = new ArtifactMaintenance(objects, repository, {
      auditIdFactory: () => "audit-fixed-a",
    });
    const reportA = await maintenanceA.audit();
    expect(reportA.auditId).toBe("audit-fixed-a");
    const planA = await maintenanceA.planRepair(reportA);

    const maintenanceB = new ArtifactMaintenance(objects, repository, {
      auditIdFactory: () => "audit-fixed-b",
    });
    const reportB = await maintenanceB.audit();
    expect(reportB.auditId).toBe("audit-fixed-b");
    const planB = await maintenanceB.planRepair(reportB);

    // Identical underlying state, different injected auditId: the repair
    // action id (a fingerprint over {auditId, operation, precondition})
    // must differ, proving the injected value is load-bearing in the id.
    expect(planA.actions).toHaveLength(1);
    expect(planB.actions).toHaveLength(1);
    expect(planA.actions[0]!.id).not.toBe(planB.actions[0]!.id);
  });

  it("maintenance: options.now defaults the repair plan's createdAt", async () => {
    const objects = new InMemoryObjectStore();
    const repository = new InMemoryArtifactRepository();
    const maintenance = new ArtifactMaintenance(objects, repository, {
      now: () => 909090,
    });
    const report = await maintenance.audit();
    const plan = await maintenance.planRepair(report);
    expect(plan.createdAt).toBe(909090);
  });

  it("maintenance: planRepair's options.createdAt overrides the injected now", async () => {
    const objects = new InMemoryObjectStore();
    const repository = new InMemoryArtifactRepository();
    const maintenance = new ArtifactMaintenance(objects, repository, {
      now: () => 1,
    });
    const report = await maintenance.audit();
    const plan = await maintenance.planRepair(report, { createdAt: 55555 });
    expect(plan.createdAt).toBe(55555);
  });

  it("InMemoryArtifactRepository: leaseIdFactory supplies the lease id", async () => {
    const repository = new InMemoryArtifactRepository({
      leaseIdFactory: () => "mem-lease-fixed",
    });
    const result = await repository.acquireObjectLease({
      objectKey: "k",
      ownerId: "o",
      mode: "shared-writer",
    });
    expect(result.status).toBe("acquired");
    expect(result.status === "acquired" && result.lease.leaseId).toBe(
      "mem-lease-fixed"
    );
  });

  it("InMemoryArtifactRepository: constructor now (previously bypassed — fixed) drives acquire/renew defaults", async () => {
    const repository = new InMemoryArtifactRepository({ now: () => 777 });
    const acquired = await repository.acquireObjectLease({
      objectKey: "k",
      ownerId: "o",
      mode: "shared-writer",
    });
    expect(acquired.status).toBe("acquired");
    if (acquired.status !== "acquired") throw new Error("unreachable");
    expect(acquired.lease.heartbeatAt).toBe(777);
    expect(acquired.lease.expiresAt).toBe(777 + 30_000);

    const renewed = await repository.renewObjectLease({
      leaseId: acquired.lease.leaseId,
      ownerId: "o",
      objectKey: "k",
      mode: "shared-writer",
      generation: acquired.lease.generation,
    });
    expect(renewed.status).toBe("acquired");
    if (renewed.status !== "acquired") throw new Error("unreachable");
    expect(renewed.lease.heartbeatAt).toBe(777);
    expect(renewed.lease.expiresAt).toBe(777 + 30_000);
  });

  it("StoreArtifactRepository: leaseIdFactory (newly injectable) supplies the lease id", async () => {
    const repository = new StoreArtifactRepository(toAsync(new InMemoryKv()), {
      leaseIdFactory: () => "store-lease-fixed",
    });
    const result = await repository.acquireObjectLease({
      objectKey: "k",
      ownerId: "o",
      mode: "shared-writer",
    });
    expect(result.status).toBe("acquired");
    expect(result.status === "acquired" && result.lease.leaseId).toBe(
      "store-lease-fixed"
    );
  });

  it("StoreArtifactRepository: constructor now drives the acquired lease's timestamps", async () => {
    const repository = new StoreArtifactRepository(toAsync(new InMemoryKv()), {
      now: () => 555,
    });
    const acquired = await repository.acquireObjectLease({
      objectKey: "k",
      ownerId: "o",
      mode: "shared-writer",
    });
    expect(acquired.status).toBe("acquired");
    if (acquired.status !== "acquired") throw new Error("unreachable");
    expect(acquired.lease.heartbeatAt).toBe(555);
    expect(acquired.lease.expiresAt).toBe(555 + 30_000);
  });
});
