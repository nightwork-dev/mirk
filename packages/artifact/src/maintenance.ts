import type {
  ArtifactAuditFinding,
  ArtifactAuditReport,
  ArtifactLeaseRepository,
  ArtifactMaintenanceRef,
  ArtifactRepairAction,
  ArtifactRepairApplyResult,
  ArtifactRepairPlan,
  ArtifactRepairPrecondition,
  ArtifactRepository,
  ListableObjectStore,
  ObjectStore,
  StoredArtifactRecord,
} from "./maintenance-types.js";

import { compareCodePoints } from "@mirk/store";
import { digestStream, makeId, metadataFingerprint } from "./util.js";
import type { ArtifactLineageEdge } from "./types.js";

export interface ArtifactMaintenanceOptions {
  now?: () => number;
  ownerId?: string;
  leaseTtlMs?: number;
  auditIdFactory?: () => string;
}

type SnapshotObject = {
  objectKey: string;
  observedSizeBytes: number;
  observedDigest?: string;
  observedEtag?: string;
};
type Snapshot = {
  refs: Map<string, SnapshotObject>;
  records: Map<string, StoredArtifactRecord>;
  edges: Map<string, ArtifactLineageEdge>;
};

/** Read-only audit and explicit, conditional repair for artifact residue. */
export class ArtifactMaintenance {
  readonly #now: () => number;
  readonly #ownerId: string;
  readonly #leaseTtlMs: number;
  readonly #auditIdFactory: () => string;
  readonly #snapshots = new Map<string, Snapshot>();

  constructor(
    readonly objects: ObjectStore,
    readonly repository: ArtifactRepository,
    options: ArtifactMaintenanceOptions = {}
  ) {
    this.#now = options.now ?? Date.now;
    this.#ownerId =
      options.ownerId ??
      `artifact-maintenance-${Math.random().toString(36).slice(2)}`;
    this.#leaseTtlMs = Math.max(1, options.leaseTtlMs ?? 30_000);
    this.#auditIdFactory = options.auditIdFactory ?? makeId;
  }

  async audit(): Promise<ArtifactAuditReport> {
    const auditId = this.#auditIdFactory();
    const records = await this.#allRecords();
    const snapshot: Snapshot = {
      refs: new Map(),
      records: new Map(records.map((record) => [record.id, record])),
      edges: new Map(),
    };
    const findings: ArtifactAuditFinding[] = [];
    const recordsByObject = new Map<string, StoredArtifactRecord[]>();
    for (const record of records) {
      const list = recordsByObject.get(record.objectKey) ?? [];
      list.push(record);
      recordsByObject.set(record.objectKey, list);
      for (const edge of await this.repository.getSources(record.id))
        snapshot.edges.set(edge.id, edge);
      for (const edge of await this.repository.getDerivatives(record.id))
        snapshot.edges.set(edge.id, edge);
    }
    for (const [objectKey, ownerRecords] of recordsByObject) {
      const head = await this.objects.head(objectKey);
      if (!head) {
        for (const record of ownerRecords)
          findings.push({
            code: "record-without-object",
            artifactId: record.id,
            detail: "artifact record has no readable object",
          });
        continue;
      }
      const actual = await this.#objectDigest(objectKey);
      if (!actual) {
        for (const record of ownerRecords)
          findings.push({
            code: "record-without-object",
            artifactId: record.id,
            detail: "artifact record has no readable object",
          });
        continue;
      }
      for (const record of ownerRecords) {
        if (actual.sizeBytes !== record.sizeBytes)
          findings.push({
            code: "size-mismatch",
            artifactId: record.id,
            detail: `stored size differs for artifact ${record.id}`,
          });
        if (actual.digest.value !== record.digest.value)
          findings.push({
            code: "digest-mismatch",
            artifactId: record.id,
            detail: `stored digest differs for artifact ${record.id}`,
          });
      }
    }
    let scannedObjects: number | undefined;
    const listable = this.#listable();
    if (listable) {
      const infos = [...(await listable.list())];
      scannedObjects = infos.length;
      for (const info of infos) {
        if (recordsByObject.has(info.key)) continue;
        const actual = await this.#objectDigest(info.key);
        const observed: SnapshotObject = {
          objectKey: info.key,
          observedSizeBytes: actual?.sizeBytes ?? info.sizeBytes,
          ...(actual ? { observedDigest: actual.digest.value } : {}),
          ...(info.etag ? { observedEtag: info.etag } : {}),
        };
        const ref = this.#opaqueRef(auditId, observed, snapshot);
        findings.push({
          code: "object-without-record",
          maintenanceRef: ref,
          detail: "object is not referenced by an artifact record",
        });
      }
    }
    this.#lineageFindings(snapshot, findings);
    findings.sort((a, b) =>
      compareCodePoints(this.#findingKey(a), this.#findingKey(b))
    );
    this.#snapshots.set(auditId, snapshot);
    return {
      auditId,
      scannedRecords: records.length,
      ...(scannedObjects === undefined ? {} : { scannedObjects }),
      findings,
      ...(scannedObjects === undefined
        ? { coverage: "partial" as const }
        : { coverage: "complete" as const }),
    };
  }

  async planRepair(
    report: ArtifactAuditReport,
    options: { createdAt?: number } = {}
  ): Promise<ArtifactRepairPlan> {
    const snapshot = this.#snapshots.get(report.auditId);
    const actions: ArtifactRepairAction[] = [];
    if (snapshot) {
      for (const finding of report.findings) {
        let operation: ArtifactRepairAction["operation"] | undefined;
        let precondition: ArtifactRepairPrecondition | undefined;
        if (
          finding.code === "object-without-record" &&
          finding.maintenanceRef
        ) {
          const object = snapshot.refs.get(finding.maintenanceRef);
          if (object) {
            operation = "delete-unreferenced-object";
            precondition = {
              kind: "object-unreferenced",
              maintenanceRef: finding.maintenanceRef,
              observedSizeBytes: object.observedSizeBytes,
              ...(object.observedDigest
                ? { observedDigest: object.observedDigest }
                : {}),
              ...(object.observedEtag
                ? { observedEtag: object.observedEtag }
                : {}),
            };
          }
        } else if (
          finding.code === "record-without-object" &&
          finding.artifactId
        ) {
          const record = snapshot.records.get(finding.artifactId);
          if (record) {
            operation = "delete-record-without-object";
            precondition = {
              kind: "record-missing-object",
              artifactId: record.id,
              recordFingerprint: this.#recordFingerprint(record),
            };
          }
        } else if (
          (finding.code === "size-mismatch" ||
            finding.code === "digest-mismatch") &&
          finding.artifactId
        ) {
          const record = snapshot.records.get(finding.artifactId);
          if (record) {
            operation = "reverify-imported-object";
            precondition = {
              kind: "artifact-descriptor-current",
              artifactId: record.id,
              descriptorFingerprint: this.#recordFingerprint(record),
            };
          }
        } else if (
          (finding.code === "lineage-missing-source" ||
            finding.code === "lineage-missing-result" ||
            finding.code === "lineage-cycle") &&
          finding.detail
        ) {
          const edge = snapshot.edges.get(finding.detail);
          if (edge) {
            operation = "remove-invalid-lineage-edge";
            precondition = {
              kind: "lineage-edge-invalid",
              edgeId: edge.id,
              edgeFingerprint: metadataFingerprint(edge),
              expectedReason:
                finding.code === "lineage-cycle"
                  ? "cycle"
                  : finding.code === "lineage-missing-source"
                  ? "missing-source"
                  : "missing-result",
            };
          }
        }
        if (operation && precondition) {
          const action = {
            id: metadataFingerprint({
              schema: "mirk-artifact-repair/v1",
              auditId: report.auditId,
              operation,
              precondition,
            }),
            operation,
            precondition,
          } as ArtifactRepairAction;
          if (!actions.some((candidate) => candidate.id === action.id))
            actions.push(action);
        }
      }
    }
    actions.sort((a, b) => compareCodePoints(a.id, b.id));
    return {
      schema: "mirk-artifact-repair/v1",
      auditId: report.auditId,
      createdAt: options.createdAt ?? this.#now(),
      actions,
    };
  }

  async applyRepair(
    plan: ArtifactRepairPlan
  ): Promise<readonly ArtifactRepairApplyResult[]> {
    const snapshot = this.#snapshots.get(plan.auditId);
    return Promise.all(
      plan.actions.map(async (action) => {
        if (!snapshot)
          return { status: "not-found", actionId: action.id } as const;
        switch (action.operation) {
          case "delete-unreferenced-object":
            return this.#deleteOrphan(action, action.precondition, snapshot);
          case "delete-record-without-object":
            return this.#deleteMissingRecord(action, action.precondition);
          case "reverify-imported-object":
            return this.#reverify(action, action.precondition);
          case "remove-invalid-lineage-edge":
            return this.#removeEdge(action, action.precondition);
        }
      })
    );
  }

  async #deleteOrphan(
    action: Extract<
      ArtifactRepairAction,
      { operation: "delete-unreferenced-object" }
    >,
    precondition: Extract<
      ArtifactRepairPrecondition,
      { kind: "object-unreferenced" }
    >,
    snapshot: Snapshot
  ): Promise<ArtifactRepairApplyResult> {
    const object = snapshot.refs.get(precondition.maintenanceRef);
    if (!object) return { status: "not-found", actionId: action.id };
    if (
      (await this.#allRecords()).some(
        (record) => record.objectKey === object.objectKey
      )
    )
      return {
        status: "conflict",
        actionId: action.id,
        reason: "reference-created",
      };
    const leases = this.#leases();
    if (!leases)
      return {
        status: "conflict",
        actionId: action.id,
        reason: "lease-unavailable",
      };
    const acquired = await leases.acquireObjectLease({
      objectKey: object.objectKey,
      ownerId: this.#ownerId,
      mode: "exclusive-delete",
      ttlMs: this.#leaseTtlMs,
      now: this.#now(),
    });
    if (acquired.status !== "acquired")
      return {
        status: "conflict",
        actionId: action.id,
        reason:
          acquired.reason === "reference-created"
            ? "reference-created"
            : "lease-unavailable",
      };
    let activeLease = acquired.lease;
    try {
      if (
        (await this.#allRecords()).some(
          (record) => record.objectKey === object.objectKey
        )
      )
        return {
          status: "conflict",
          actionId: action.id,
          reason: "reference-created",
        };
      const renewedBeforeRead = await leases.renewObjectLease({
        ...activeLease,
        ttlMs: this.#leaseTtlMs,
        now: this.#now(),
      });
      if (renewedBeforeRead.status !== "acquired")
        return {
          status: "conflict",
          actionId: action.id,
          reason: "lease-unavailable",
        };
      activeLease = renewedBeforeRead.lease;
      const head = await this.objects.head(object.objectKey);
      const actual = head
        ? await this.#objectDigest(object.objectKey)
        : undefined;
      if (!head || !actual) return { status: "not-found", actionId: action.id };
      if (
        actual.sizeBytes !== precondition.observedSizeBytes ||
        (precondition.observedDigest &&
          actual.digest.value !== precondition.observedDigest) ||
        (precondition.observedEtag && head.etag !== precondition.observedEtag)
      )
        return {
          status: "conflict",
          actionId: action.id,
          reason: "object-changed",
        };
      const renewedBeforeDelete = await leases.renewObjectLease({
        ...activeLease,
        ttlMs: this.#leaseTtlMs,
        now: this.#now(),
      });
      if (renewedBeforeDelete.status !== "acquired")
        return {
          status: "conflict",
          actionId: action.id,
          reason: "lease-unavailable",
        };
      activeLease = renewedBeforeDelete.lease;
      if (
        (await this.#allRecords()).some(
          (record) => record.objectKey === object.objectKey
        )
      )
        return {
          status: "conflict",
          actionId: action.id,
          reason: "reference-created",
        };
      const finalHead = await this.objects.head(object.objectKey);
      const finalActual = finalHead
        ? await this.#objectDigest(object.objectKey)
        : undefined;
      if (!finalHead || !finalActual)
        return { status: "not-found", actionId: action.id };
      if (
        finalActual.sizeBytes !== precondition.observedSizeBytes ||
        (precondition.observedDigest &&
          finalActual.digest.value !== precondition.observedDigest) ||
        (precondition.observedEtag &&
          finalHead.etag !== precondition.observedEtag)
      )
        return {
          status: "conflict",
          actionId: action.id,
          reason: "object-changed",
        };
      await this.objects.delete(object.objectKey);
      return { status: "applied", actionId: action.id };
    } finally {
      await leases.releaseObjectLease(activeLease).catch(() => false);
    }
  }

  async #deleteMissingRecord(
    action: Extract<
      ArtifactRepairAction,
      { operation: "delete-record-without-object" }
    >,
    precondition: Extract<
      ArtifactRepairPrecondition,
      { kind: "record-missing-object" }
    >
  ): Promise<ArtifactRepairApplyResult> {
    const record = await this.repository.get(precondition.artifactId);
    if (!record) return { status: "not-found", actionId: action.id };
    if (
      this.#recordFingerprint(record) !== precondition.recordFingerprint ||
      (await this.objects.head(record.objectKey))
    )
      return {
        status: "conflict",
        actionId: action.id,
        reason: "state-changed",
      };
    await this.repository.delete(record.id);
    return { status: "applied", actionId: action.id };
  }

  async #reverify(
    action: Extract<
      ArtifactRepairAction,
      { operation: "reverify-imported-object" }
    >,
    precondition: Extract<
      ArtifactRepairPrecondition,
      { kind: "artifact-descriptor-current" }
    >
  ): Promise<ArtifactRepairApplyResult> {
    const record = await this.repository.get(precondition.artifactId);
    if (!record) return { status: "not-found", actionId: action.id };
    if (this.#recordFingerprint(record) !== precondition.descriptorFingerprint)
      return {
        status: "conflict",
        actionId: action.id,
        reason: "state-changed",
      };
    const actual = await this.#objectDigest(record.objectKey);
    if (
      !actual ||
      actual.sizeBytes !== record.sizeBytes ||
      actual.digest.value !== record.digest.value
    )
      return {
        status: "conflict",
        actionId: action.id,
        reason: "object-changed",
      };
    return { status: "applied", actionId: action.id };
  }

  async #removeEdge(
    action: Extract<
      ArtifactRepairAction,
      { operation: "remove-invalid-lineage-edge" }
    >,
    precondition: Extract<
      ArtifactRepairPrecondition,
      { kind: "lineage-edge-invalid" }
    >
  ): Promise<ArtifactRepairApplyResult> {
    const edge = await this.#findEdge(precondition.edgeId);
    if (!edge) return { status: "not-found", actionId: action.id };
    if (metadataFingerprint(edge) !== precondition.edgeFingerprint)
      return {
        status: "conflict",
        actionId: action.id,
        reason: "state-changed",
      };
    if (!this.repository.removeLineage)
      return {
        status: "conflict",
        actionId: action.id,
        reason: "state-changed",
      };
    const source = await this.repository.get(edge.sourceArtifactId);
    const result = await this.repository.get(edge.resultArtifactId);
    const stillInvalid =
      precondition.expectedReason === "missing-source"
        ? !source
        : precondition.expectedReason === "missing-result"
        ? !result
        : await this.#edgeParticipatesInCycle(edge);
    if (!stillInvalid)
      return {
        status: "conflict",
        actionId: action.id,
        reason: "state-changed",
      };
    await this.repository.removeLineage(edge.id);
    return { status: "applied", actionId: action.id };
  }

  async #allRecords(): Promise<StoredArtifactRecord[]> {
    const result: StoredArtifactRecord[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.repository.list({
        limit: 500,
        ...(cursor ? { cursor } : {}),
      });
      result.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor);
    return result;
  }
  async #objectDigest(
    key: string
  ): Promise<
    | { digest: { algorithm: "sha256"; value: string }; sizeBytes: number }
    | undefined
  > {
    try {
      const stream = await this.objects.get(key);
      return stream ? await digestStream(stream) : undefined;
    } catch {
      return undefined;
    }
  }
  #listable(): ListableObjectStore | undefined {
    return typeof (this.objects as Partial<ListableObjectStore>).list ===
      "function"
      ? (this.objects as ListableObjectStore)
      : undefined;
  }
  #leases(): ArtifactLeaseRepository | undefined {
    const candidate = this.repository as Partial<ArtifactLeaseRepository> & {
      atomicAvailable?: boolean;
    };
    return typeof candidate.acquireObjectLease === "function" &&
      candidate.atomicAvailable !== false
      ? (this.repository as unknown as ArtifactLeaseRepository)
      : undefined;
  }
  #recordFingerprint(record: StoredArtifactRecord): string {
    return metadataFingerprint(record);
  }
  #opaqueRef(
    auditId: string,
    object: SnapshotObject,
    snapshot: Snapshot
  ): ArtifactMaintenanceRef {
    const ref = `ref-${auditId}-${
      snapshot.refs.size + 1
    }` as ArtifactMaintenanceRef;
    snapshot.refs.set(ref, object);
    return ref;
  }
  #findingKey(finding: ArtifactAuditFinding): string {
    return [
      finding.code,
      finding.artifactId ?? "",
      finding.maintenanceRef ?? "",
      finding.detail ?? "",
    ].join("\u0000");
  }
  #lineageFindings(snapshot: Snapshot, findings: ArtifactAuditFinding[]): void {
    const records = snapshot.records;
    for (const edge of snapshot.edges.values()) {
      const missingSource = !records.has(edge.sourceArtifactId);
      const missingResult = !records.has(edge.resultArtifactId);
      if (missingSource)
        findings.push({ code: "lineage-missing-source", detail: edge.id });
      if (missingResult)
        findings.push({ code: "lineage-missing-result", detail: edge.id });
    }
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const walk = (id: string): boolean => {
      if (visiting.has(id)) return true;
      if (visited.has(id)) return false;
      visiting.add(id);
      for (const edge of snapshot.edges.values())
        if (edge.sourceArtifactId === id && walk(edge.resultArtifactId)) {
          findings.push({ code: "lineage-cycle", detail: edge.id });
          visiting.delete(id);
          return true;
        }
      visiting.delete(id);
      visited.add(id);
      return false;
    };
    for (const id of records.keys()) walk(id);
  }
  async #findEdge(id: string): Promise<ArtifactLineageEdge | undefined> {
    for (const record of await this.#allRecords()) {
      const incoming = (await this.repository.getSources(record.id)).find(
        (candidate) => candidate.id === id
      );
      if (incoming) return incoming;
      const outgoing = (await this.repository.getDerivatives(record.id)).find(
        (candidate) => candidate.id === id
      );
      if (outgoing) return outgoing;
    }
    return undefined;
  }
  async #edgeParticipatesInCycle(edge: ArtifactLineageEdge): Promise<boolean> {
    const seen = new Set<string>();
    const walk = async (id: string): Promise<boolean> => {
      if (id === edge.sourceArtifactId) return true;
      if (seen.has(id)) return false;
      seen.add(id);
      for (const candidate of await this.repository.getDerivatives(id)) {
        if (candidate.id === edge.id) continue;
        if (await walk(candidate.resultArtifactId)) return true;
      }
      return false;
    };
    return walk(edge.resultArtifactId);
  }
}

export async function auditArtifacts(
  objects: ObjectStore,
  repository: ArtifactRepository,
  options?: ArtifactMaintenanceOptions
): Promise<ArtifactAuditReport> {
  return new ArtifactMaintenance(objects, repository, options).audit();
}

export type {
  ArtifactAuditCode,
  ArtifactAuditFinding,
  ArtifactAuditReport,
  ArtifactMaintenanceRef,
  ArtifactRepairAction,
  ArtifactRepairApplyResult,
  ArtifactRepairPlan,
  ArtifactRepairPrecondition,
} from "./maintenance-types.js";
