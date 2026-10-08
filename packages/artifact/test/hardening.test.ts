import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { canonicalDigest, canonicalJson } from "@mirk/store";
import { InMemoryKv, toAsync } from "@mirk/store/kv";
import { describe, expect, it } from "vitest";
import {
  ArtifactConflictError,
  ArtifactCoordinator,
  ArtifactMaintenance,
  ArtifactValidationError,
  InMemoryArtifactRepository,
  InMemoryObjectStore,
  assertPortableMetadata,
  artifactFinalizationDigest,
} from "../src/index.js";
import type { ArtifactLeaseResult } from "../src/index.js";
import { StoreArtifactRepository } from "../src/store.js";

const bytes = (value: string) => new TextEncoder().encode(value);

describe("artifact finalization hardening", () => {
  it("rejects a non-string producer system with the typed validation error", () => {
    expect(() =>
      assertPortableMetadata({
        mediaType: "text/plain",
        producer: { system: 17 } as never,
      })
    ).toThrow(ArtifactValidationError);
    expect(() =>
      assertPortableMetadata({
        mediaType: "text/plain",
        producer: { system: 17 } as never,
      })
    ).toThrowError(expect.objectContaining({ code: "invalid-producer" }));
  });

  it("computes a stable Mirk finalization digest and atomically replays", async () => {
    const repository = new StoreArtifactRepository(toAsync(new InMemoryKv()));
    const objects = new InMemoryObjectStore();
    const coordinator = new ArtifactCoordinator(objects, repository, {
      concurrency: { mode: "repository-atomic" },
      idFactory: (() => {
        let n = 0;
        return () => `a-${++n}`;
      })(),
    });
    const first = await coordinator.write({
      bytes: bytes("same"),
      mediaType: "text/plain",
      filename: "x.txt",
      idempotencyKey: "attempt:slot",
    });
    const replay = await coordinator.write({
      bytes: bytes("same"),
      mediaType: "text/plain",
      filename: "x.txt",
      idempotencyKey: "attempt:slot",
    });
    expect(replay.id).toBe(first.id);
    await expect(
      coordinator.write({
        bytes: bytes("different physical retry"),
        mediaType: "text/plain",
        filename: "x.txt",
        idempotencyKey: "attempt:slot",
      })
    ).rejects.toBeInstanceOf(ArtifactConflictError);
    const record = await repository.get(first.id);
    expect(record).toBeDefined();
    expect(artifactFinalizationDigest(record!)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("replays against the original receipt after mutable annotation updates", async () => {
    const repository = new StoreArtifactRepository(toAsync(new InMemoryKv()));
    const objects = new InMemoryObjectStore();
    const coordinator = new ArtifactCoordinator(objects, repository, {
      concurrency: { mode: "repository-atomic" },
      idFactory: (() => {
        let n = 0;
        return () => `mutable-${++n}`;
      })(),
    });
    const first = await coordinator.write({
      bytes: bytes("same"),
      mediaType: "text/plain",
      annotations: { phase: "initial" },
      idempotencyKey: "mutable",
    });
    await repository.updateAnnotations(first.id, { phase: "updated" });
    const replay = await coordinator.write({
      bytes: bytes("same"),
      mediaType: "text/plain",
      annotations: { phase: "initial" },
      idempotencyKey: "mutable",
    });
    expect(replay.id).toBe(first.id);
    expect((await repository.get(first.id))?.annotations).toEqual({
      phase: "updated",
    });
  });

  it("blocks an orphan repair while a shared finalizer lease is live", async () => {
    let now = 100;
    const repository = new InMemoryArtifactRepository({
      now: () => now,
      leaseIdFactory: (() => {
        let n = 0;
        return () => `lease-${++n}`;
      })(),
    });
    const objects = new InMemoryObjectStore();
    await objects.put("orphan", bytes("orphan"));
    const maintenance = new ArtifactMaintenance(objects, repository, {
      now: () => now,
    });
    const report = await maintenance.audit();
    const plan = await maintenance.planRepair(report, { createdAt: now });
    const lease = await repository.acquireObjectLease({
      objectKey: "orphan",
      ownerId: "writer",
      mode: "shared-writer",
      now,
      ttlMs: 1000,
    });
    expect(lease.status).toBe("acquired");
    expect((await maintenance.applyRepair(plan))[0]).toMatchObject({
      status: "conflict",
      reason: "lease-unavailable",
    });
    now += 2000;
    expect((await maintenance.applyRepair(plan))[0]).toMatchObject({
      status: "applied",
    });
    expect(await objects.head("orphan")).toBeUndefined();
  });

  it("returns a partial audit without object enumeration", async () => {
    const repository = new InMemoryArtifactRepository();
    const base = new InMemoryObjectStore();
    const objects = {
      put: base.put.bind(base),
      get: base.get.bind(base),
      head: base.head.bind(base),
      delete: base.delete.bind(base),
    };
    const report = await new ArtifactMaintenance(objects, repository).audit();
    expect(report.coverage).toBe("partial");
    expect(report.scannedObjects).toBeUndefined();
  });

  it("scopes idempotency keys to the coordinator namespace", async () => {
    const repository = new InMemoryArtifactRepository();
    const objects = new InMemoryObjectStore();
    let next = 0;
    const one = new ArtifactCoordinator(objects, repository, {
      namespace: "one",
      idFactory: () => `one-${++next}`,
    });
    const two = new ArtifactCoordinator(objects, repository, {
      namespace: "two",
      idFactory: () => `two-${++next}`,
    });
    const first = await one.write({
      bytes: bytes("same"),
      mediaType: "text/plain",
      idempotencyKey: "shared-key",
    });
    const second = await two.write({
      bytes: bytes("same"),
      mediaType: "text/plain",
      idempotencyKey: "shared-key",
    });
    expect(second.id).not.toBe(first.id);
    expect((await repository.list()).items).toHaveLength(2);
  });

  it("audits and conditionally removes a lineage cycle", async () => {
    const store = new InMemoryKv();
    const repository = new StoreArtifactRepository(toAsync(store));
    for (const id of ["a", "b", "c"])
      await repository.create({
        id,
        objectKey: `objects/${id}`,
        mediaType: "text/plain",
        sizeBytes: 1,
        digest: { algorithm: "sha256", value: id },
        createdAt: 1,
      });
    const edges = [
      {
        id: "edge-a-b",
        sourceArtifactId: "a",
        resultArtifactId: "b",
        operation: "test",
        createdAt: 1,
      },
      {
        id: "edge-b-c",
        sourceArtifactId: "b",
        resultArtifactId: "c",
        operation: "test",
        createdAt: 1,
      },
      {
        id: "edge-c-a",
        sourceArtifactId: "c",
        resultArtifactId: "a",
        operation: "test",
        createdAt: 1,
      },
    ];
    for (const edge of edges) store.put("mirk-artifacts:lineage", edge);
    const report = await new ArtifactMaintenance(
      new InMemoryObjectStore(),
      repository
    ).audit();
    expect(
      report.findings.some((finding) => finding.code === "lineage-cycle")
    ).toBe(true);
    const maintenance = new ArtifactMaintenance(
      new InMemoryObjectStore(),
      repository
    );
    const sameReport = await maintenance.audit();
    const samePlan = await maintenance.planRepair(sameReport);
    const results = await maintenance.applyRepair(samePlan);
    expect(results.some((result) => result.status === "applied")).toBe(true);
    expect((await repository.getSources("a")).length).toBeLessThan(2);
  });

  it("does not delete after an exclusive lease expires during inspection", async () => {
    let now = 100;
    let entered!: () => void;
    let release!: () => void;
    let block = false;
    const enteredPromise = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const releasePromise = new Promise<void>((resolve) => {
      release = resolve;
    });
    class BlockingObjects extends InMemoryObjectStore {
      override async get(key: string) {
        if (block && key === "orphan") {
          entered();
          await releasePromise;
        }
        return super.get(key);
      }
    }
    const objects = new BlockingObjects();
    const repository = new InMemoryArtifactRepository({ now: () => now });
    await objects.put("orphan", bytes("orphan"));
    const maintenance = new ArtifactMaintenance(objects, repository, {
      now: () => now,
      leaseTtlMs: 10,
    });
    const report = await maintenance.audit();
    const plan = await maintenance.planRepair(report);
    block = true;
    const applying = maintenance.applyRepair(plan);
    await enteredPromise;
    now = 200;
    const successor = await repository.acquireObjectLease({
      objectKey: "orphan",
      ownerId: "writer",
      mode: "shared-writer",
      now,
      ttlMs: 100,
    });
    expect(successor.status).toBe("acquired");
    release();
    expect((await applying)[0]).toMatchObject({
      status: "conflict",
      reason: "lease-unavailable",
    });
    expect(await objects.head("orphan")).toBeDefined();
  });

  it("does not disguise object-store failures as repair conflicts", async () => {
    const unavailable = new Error("object store unavailable");
    class FailingDeleteObjects extends InMemoryObjectStore {
      override async delete(): Promise<boolean> {
        throw unavailable;
      }
    }

    const objects = new FailingDeleteObjects();
    const repository = new InMemoryArtifactRepository();
    await objects.put("orphan", bytes("orphan"));
    const maintenance = new ArtifactMaintenance(objects, repository);
    const report = await maintenance.audit();
    const plan = await maintenance.planRepair(report);

    await expect(maintenance.applyRepair(plan)).rejects.toBe(unavailable);
  });

  it("keeps an existing object when head fails before a put begins", async () => {
    const unavailable = new Error("head unavailable");
    class HeadFailingObjects extends InMemoryObjectStore {
      fail = true;
      override async head(key: string) {
        if (this.fail) throw unavailable;
        return super.head(key);
      }
    }
    const objects = new HeadFailingObjects();
    await objects.put("artifacts/fixed", bytes("existing"));
    const coordinator = new ArtifactCoordinator(
      objects,
      new InMemoryArtifactRepository(),
      { idFactory: () => "fixed" }
    );
    await expect(
      coordinator.write({ bytes: bytes("replacement"), mediaType: "text/plain" })
    ).rejects.toBe(unavailable);
    objects.fail = false;
    expect(await objects.get("artifacts/fixed")).toBeDefined();
  });

  it("uses an exclusive lease before deleting bytes when a writer races", async () => {
    class RacingRepository extends InMemoryArtifactRepository {
      raced = false;
      override async acquireObjectLease(
        input: Parameters<InMemoryArtifactRepository["acquireObjectLease"]>[0]
      ): Promise<ArtifactLeaseResult> {
        if (input.mode === "exclusive-delete" && !this.raced) {
          this.raced = true;
          await super.acquireObjectLease({
            objectKey: input.objectKey,
            ownerId: "racing-writer",
            mode: "shared-writer",
            ttlMs: input.ttlMs,
            now: input.now,
          });
        }
        return super.acquireObjectLease(input);
      }
    }
    const objects = new InMemoryObjectStore();
    const repository = new RacingRepository();
    const coordinator = new ArtifactCoordinator(
      objects,
      repository,
      { idFactory: () => "raced" }
    );
    const artifact = await coordinator.write({
      bytes: bytes("value"),
      mediaType: "text/plain",
    });
    await expect(coordinator.delete(artifact.id)).rejects.toMatchObject({
      code: "object-deletion-failed",
    });
    expect(await repository.get(artifact.id)).toBeUndefined();
    expect(await objects.head("artifacts/raced")).toBeDefined();
  });

  it("renews the delete lease after the final reference scan", async () => {
    let now = 1_000;
    class ExpiringRepository extends InMemoryArtifactRepository {
      scans = 0;
      override async list(
        query: Parameters<InMemoryArtifactRepository["list"]>[0] = {}
      ): ReturnType<InMemoryArtifactRepository["list"]> {
        const page = await super.list(query);
        this.scans += 1;
        if (this.scans === 2) {
          now = 2_000;
          const importer = new ArtifactCoordinator(objects, this, {
            idFactory: () => "imported",
            now: () => now,
            ownerId: "importer",
            leaseTtlMs: 10,
          });
          await importer.import({
            objectKey: "artifacts/target",
            mediaType: "text/plain",
          });
        }
        return page;
      }
    }
    const objects = new InMemoryObjectStore();
    const repository = new ExpiringRepository({ now: () => now });
    const coordinator = new ArtifactCoordinator(objects, repository, {
      idFactory: () => "target",
      now: () => now,
      ownerId: "deleter",
      leaseTtlMs: 10,
    });
    const artifact = await coordinator.write({
      bytes: bytes("value"),
      mediaType: "text/plain",
    });
    await expect(coordinator.delete(artifact.id)).rejects.toMatchObject({
      code: "object-deletion-failed",
    });
    expect(await repository.get("imported")).toBeDefined();
    expect(await objects.head("artifacts/target")).toBeDefined();
  });

  it("renews the repair lease after the final reference and digest checks", async () => {
    let now = 1_000;
    class ExpiringRepository extends InMemoryArtifactRepository {
      scans = 0;
      override async list(
        query: Parameters<InMemoryArtifactRepository["list"]>[0] = {}
      ): ReturnType<InMemoryArtifactRepository["list"]> {
        const page = await super.list(query);
        this.scans += 1;
        if (this.scans === 3) {
          now = 2_000;
          const importer = new ArtifactCoordinator(objects, this, {
            idFactory: () => "imported",
            now: () => now,
            ownerId: "importer",
            leaseTtlMs: 10,
          });
          await importer.import({ objectKey: "orphan", mediaType: "text/plain" });
        }
        return page;
      }
    }
    const objects = new InMemoryObjectStore();
    const repository = new ExpiringRepository({ now: () => now });
    await objects.put("orphan", bytes("orphan"));
    const maintenance = new ArtifactMaintenance(objects, repository, {
      now: () => now,
      leaseTtlMs: 10,
      auditIdFactory: () => "audit",
    });
    const report = await maintenance.audit();
    repository.scans = 0;
    const plan = await maintenance.planRepair(report);
    const [result] = await maintenance.applyRepair(plan);
    expect(result).toMatchObject({ status: "conflict", reason: "lease-unavailable" });
    expect(await repository.get("imported")).toBeDefined();
    expect(await objects.head("orphan")).toBeDefined();
  });
});

describe("canonicalDigest", () => {
  it("matches the noble SHA-256 of canonical JSON, including non-ASCII and lone surrogates", () => {
    const inputs: unknown[] = [
      null,
      { b: 1, a: [true, "x"] },
      { name: "caf\u00e9 \u2615 \u65e5\u672c\u8a9e \u{1F600}" },
      { lone: "\uD800", trailing: "a\uDFFF", reversed: "\uDC00\uD800" },
      { long: "y".repeat(10_000) },
    ];
    for (const input of inputs) {
      expect(canonicalDigest(input)).toBe(
        bytesToHex(sha256(utf8ToBytes(canonicalJson(input))))
      );
    }
  });
});
