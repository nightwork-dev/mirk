import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, afterEach } from "vitest";

import {
  createSqliteStatementStore,
  compareLegacySurface,
  type StatementAdmissionAuthority,
  type StatementAdmissionDecision,
  type StatementAdmissionEnvelope,
  type StatementAdmissionRequest,
  type StatementProvenance,
  type StatementRecord,
} from "../src/index.js";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length)
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

class AllowAuthority implements StatementAdmissionAuthority {
  readonly authorityId = "test-authority";
  readonly authorityRevision = "rev-1";

  constructor(private readonly status: "accepted" | "proposed" = "accepted") {}

  decide(
    _auth: StatementAdmissionEnvelope["auth"],
    _request: StatementAdmissionRequest
  ): StatementAdmissionDecision {
    return {
      outcome: { kind: "admit", status: this.status, reason: "test" },
      decidedAt: 1,
    };
  }
}

class RefuseAuthority implements StatementAdmissionAuthority {
  readonly authorityId = "refuse-authority";
  readonly authorityRevision = "rev-1";

  decide(): StatementAdmissionDecision {
    return {
      outcome: { kind: "refuse", code: "nope" },
      decidedAt: 1,
    };
  }
}

describe("@mirk/statements sqlite adapter", () => {
  it("runs migrations and admits a statement with a durable receipt", async () => {
    const store = testStore(new AllowAuthority());
    const result = await store.admit(admission({ idempotencyKey: "first" }));

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected commit");
    expect(result.statement.revision).toBe(1);
    expect(result.statement.status).toBe("accepted");
    expect(result.receipt.code).toBe("committed");
    expect(result.receipt.metadata.schemaVersion).toBe("statements-storage/v1");
    expect(store.getHead(ref("s1"))).toEqual(result.statement);
    store.close();
  });

  it("returns exact idempotent replay and persists idempotency conflicts", async () => {
    const path = testStorePath();
    const store = testStore(new AllowAuthority(), path);
    const first = await store.admit(admission({ idempotencyKey: "same" }));
    const replay = await store.admit(admission({ idempotencyKey: "same" }));
    const conflict = await store.admit(
      admission({ idempotencyKey: "same", statementId: "other" })
    );
    const conflictReplay = await store.admit(
      admission({ idempotencyKey: "same", statementId: "other" })
    );

    expect(first.ok).toBe(true);
    expect(replay.ok).toBe(true);
    expect(replay.replay).toBe(true);
    expect(conflict.ok).toBe(false);
    if (conflict.ok) throw new Error("expected refusal");
    expect(conflict.code).toBe("idempotency-conflict");
    expect(conflictReplay.ok).toBe(false);
    if (conflictReplay.ok) throw new Error("expected replayed refusal");
    expect(conflictReplay.replay).toBe(true);
    expect(conflictReplay.receipt).toEqual(conflict.receipt);
    store.close();

    const reopened = testStore(new AllowAuthority(), path);
    const reopenedConflictReplay = await reopened.admit(
      admission({ idempotencyKey: "same", statementId: "other" })
    );
    expect(reopenedConflictReplay.ok).toBe(false);
    if (reopenedConflictReplay.ok) throw new Error("expected durable refusal");
    expect(reopenedConflictReplay.replay).toBe(true);
    expect(reopenedConflictReplay.receipt).toEqual(conflict.receipt);
    expect(reopened.getHead(ref("s1"))).toEqual(first.statement);
    expect(reopened.getHead(ref("other"))).toBeNull();
    reopened.close();
  });

  it("serializes revision admission and records conflicts", async () => {
    const store = testStore(new AllowAuthority());
    await store.admit(admission({ idempotencyKey: "base" }));
    const first = await store.revise({
      ...baseEnvelope("revise-ok", "s1"),
      expectedRevision: 1,
      patch: { status: "accepted", qualifiers: { note: "updated" } },
    });
    const stale = await store.revise({
      ...baseEnvelope("revise-stale", "s1"),
      expectedRevision: 1,
      patch: { status: "accepted", qualifiers: { note: "stale" } },
    });

    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error("expected revision");
    expect(first.statement.revision).toBe(2);
    expect(store.getHead(ref("s1"))?.qualifiers).toEqual({ note: "updated" });
    expect(stale.ok).toBe(false);
    if (stale.ok) throw new Error("expected conflict");
    expect(stale.code).toBe("revision-conflict");
    store.close();
  });

  it("forces model-shaped and inferred material to proposed", async () => {
    const store = testStore(new AllowAuthority("accepted"));
    const result = await store.admit(
      admission({
        idempotencyKey: "model",
        provenance: provenance({ source: "inferred", modelInvolved: true }),
      })
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected commit");
    expect(result.statement.status).toBe("proposed");
    store.close();
  });

  it("keeps refusals durable for replay", async () => {
    const store = testStore(new RefuseAuthority());
    const first = await store.admit(admission({ idempotencyKey: "refused" }));
    const replay = await store.admit(admission({ idempotencyKey: "refused" }));

    expect(first.ok).toBe(false);
    expect(replay.ok).toBe(false);
    expect(replay.replay).toBe(true);
    if (replay.ok) throw new Error("expected refusal");
    expect(replay.code).toBe("authority-refused");
    store.close();
  });

  it("answers bitemporal branch and actor lens queries from heads", async () => {
    const store = testStore(new AllowAuthority());
    await store.admit(
      admission({ idempotencyKey: "world", statementId: "world-fact" })
    );
    await store.admit(
      admission({
        idempotencyKey: "actor",
        statementId: "actor-belief",
        contextKind: "actor-epistemic",
        actorInstanceId: "fatima@branch-a",
        modality: "belief",
      })
    );

    const truth = store.query({
      worldId: "verra",
      branchId: "main",
      contextKind: "world-version",
      statuses: ["accepted"],
      validAt: "1910-01-01T00:00:00.000Z",
    });
    const actor = store.query({
      worldId: "verra",
      branchId: "main",
      actorInstanceId: "fatima@branch-a",
      modalities: ["belief"],
    });

    expect(truth.map((item) => item.statementId)).toEqual(["world-fact"]);
    expect(actor.map((item) => item.statementId)).toEqual(["actor-belief"]);
    store.close();
  });

  it("persists resumable backfill cursors", () => {
    const store = testStore(new AllowAuthority());
    store.beginBackfill("game-claims", "sigil-game-knowledge-claim-v1", {
      offset: 10,
    });
    const updated = store.updateBackfill(
      "game-claims",
      "sigil-game-knowledge-claim-v1",
      "running",
      { offset: 20 }
    );

    expect(updated.cursor).toEqual({ offset: 20 });
    expect(store.getBackfill("game-claims")).toEqual(updated);
    store.close();
  });

  it("rejects envelope/context branch drift before mutating", async () => {
    const store = testStore(new AllowAuthority());
    await expect(
      store.admit({
        ...admission({ idempotencyKey: "drift" }),
        context: {
          kind: "world-version",
          worldId: "verra",
          branchId: "other",
        },
      })
    ).rejects.toThrow("context.branchId must match");
    expect(store.query({ worldId: "verra", branchId: "main" })).toEqual([]);
    expect(store.query({ worldId: "verra", branchId: "other" })).toEqual([]);
    store.close();
  });

  it("runs a named dual-read parity harness against a legacy game claim surface", async () => {
    const store = testStore(new AllowAuthority());
    const admitted = await store.admit(
      admission({ idempotencyKey: "claim", statementId: "claim-1" })
    );
    if (!admitted.ok) throw new Error("expected commit");

    const report = compareLegacySurface(store, {
      name: "sigil-game-knowledge-claim-v1",
      read: () => [admitted.statement],
      toStatement: (record: StatementRecord) => record,
    });

    expect(report.legacySurfaceName).toBe("sigil-game-knowledge-claim-v1");
    expect(report.checked).toBe(1);
    expect(report.missingCanonical).toEqual([]);
    expect(report.issues).toEqual([]);
    store.close();
  });

  it("keeps indexed lens queries within the Stage 0 baseline budget", async () => {
    const store = testStore(new AllowAuthority());
    const records: StatementRecord[] = [];
    for (let i = 0; i < 750; i += 1) {
      const result = await store.admit(
        admission({
          idempotencyKey: `bench-${i}`,
          statementId: `bench-${i}`,
          branchId: i % 2 === 0 ? "main" : "fork",
          contextKind: i % 3 === 0 ? "actor-epistemic" : "world-version",
          actorInstanceId: i % 3 === 0 ? "actor-1" : undefined,
          recordedAt: `2026-08-01T00:${String(i % 60).padStart(
            2,
            "0"
          )}:00.000Z`,
        })
      );
      if (result.ok) records.push(result.statement);
    }

    const query = {
      worldId: "verra",
      branchId: "main",
      statuses: ["accepted" as const],
      validAt: "1910-01-01T00:00:00.000Z",
      limit: 50,
    };
    const baselineStart = performance.now();
    for (let i = 0; i < 200; i += 1) {
      records
        .map((record) => JSON.parse(JSON.stringify(record)) as StatementRecord)
        .filter((record) => record.context.worldId === query.worldId)
        .filter((record) => record.context.branchId === query.branchId)
        .filter((record) => record.status === "accepted")
        .slice(0, query.limit);
    }
    const baselineMs = performance.now() - baselineStart;

    const indexedStart = performance.now();
    for (let i = 0; i < 200; i += 1) store.query(query);
    const indexedMs = performance.now() - indexedStart;

    expect(indexedMs).toBeLessThan(Math.max(25, baselineMs * 1.2));
    store.close();
  });
});

function testStorePath() {
  const dir = mkdtempSync(join(tmpdir(), "mirk-statements-"));
  tempDirs.push(dir);
  return join(dir, "statements.sqlite");
}

function testStore(
  authority: StatementAdmissionAuthority,
  path = testStorePath()
) {
  return createSqliteStatementStore({
    path,
    authority,
    now: () => new Date("2026-08-01T00:00:00.000Z"),
    receiptIdFactory: () => `receipt-${Math.random().toString(36).slice(2)}`,
  });
}

function baseEnvelope(idempotencyKey: string, statementId = "s1") {
  return {
    auth: {
      principalId: "principal:david",
      authorityScope: "world:verra",
      callerPolicy: "test-policy",
    },
    idempotencyKey,
    worldId: "verra",
    branchId: "main",
    statementId,
    recordedAt: "2026-08-01T00:00:00.000Z",
    receiptMetadata: {
      stage: "ST.2",
      owner: "Mirk",
    },
  };
}

function admission(
  overrides: Partial<StatementAdmissionEnvelope> & {
    contextKind?: StatementAdmissionEnvelope["context"]["kind"];
    actorInstanceId?: string;
  } = {}
): StatementAdmissionEnvelope {
  const statementId = overrides.statementId ?? "s1";
  const branchId = overrides.branchId ?? "main";
  const contextKind = overrides.contextKind ?? "world-version";
  const actorInstanceId = overrides.actorInstanceId;
  return {
    ...baseEnvelope(overrides.idempotencyKey ?? "default", statementId),
    branchId,
    proposition: {
      subject: { entityId: "fatima" },
      predicate: { predicateId: "is-in" },
      object: { kind: "string", value: "Roslyn" },
    },
    context: {
      kind: contextKind,
      worldId: "verra",
      branchId,
      ...(actorInstanceId ? { actorInstanceId } : {}),
    },
    modality: overrides.modality ?? "fact",
    polarity: "positive",
    status: "accepted",
    validTime: {
      from: { kind: "instant", at: "1900-01-01T00:00:00.000Z" },
      to: { kind: "instant", at: "1920-01-01T00:00:00.000Z" },
    },
    qualifiers: {},
    provenance: overrides.provenance ?? provenance(),
    derivedFrom: [],
    ...overrides,
  };
}

function provenance(
  origin: StatementProvenance["origin"] = {
    source: "authored",
    modelInvolved: false,
  }
): StatementProvenance {
  return {
    sources: [{ sourceId: "source:verra", anchor: "lore.md#fatima" }],
    origin,
  };
}

function ref(statementId: string) {
  return { worldId: "verra", branchId: "main", statementId };
}
