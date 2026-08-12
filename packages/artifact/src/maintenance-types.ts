import type {
  ArtifactObjectLease,
  ArtifactRepository,
  ArtifactLeaseRepository,
  ArtifactLineageEdge,
  ArtifactDescriptor,
  ListableObjectStore,
  ObjectInfo,
  ObjectStore,
  StoredArtifactRecord,
} from "./types.js";

export type ArtifactMaintenanceRef = string & {
  readonly __artifactMaintenanceRef: true;
};
export type ArtifactAuditCode =
  | "object-without-record"
  | "record-without-object"
  | "size-mismatch"
  | "digest-mismatch"
  | "lineage-missing-source"
  | "lineage-missing-result"
  | "lineage-cycle";
export interface ArtifactAuditFinding {
  code: ArtifactAuditCode;
  artifactId?: string;
  maintenanceRef?: ArtifactMaintenanceRef;
  detail?: string;
}
export interface ArtifactAuditReport {
  auditId: string;
  scannedRecords: number;
  scannedObjects?: number;
  findings: readonly ArtifactAuditFinding[];
  coverage?: "partial" | "complete";
}
export type ArtifactRepairPrecondition =
  | {
      kind: "object-unreferenced";
      maintenanceRef: ArtifactMaintenanceRef;
      observedDigest?: string;
      observedSizeBytes: number;
      observedEtag?: string;
    }
  | {
      kind: "record-missing-object";
      artifactId: string;
      recordFingerprint: string;
    }
  | {
      kind: "lineage-edge-invalid";
      edgeId: string;
      edgeFingerprint: string;
      expectedReason: "missing-source" | "missing-result" | "cycle";
    }
  | {
      kind: "artifact-descriptor-current";
      artifactId: string;
      descriptorFingerprint: string;
    };
export type ArtifactRepairAction =
  | {
      id: string;
      operation: "delete-unreferenced-object";
      precondition: Extract<
        ArtifactRepairPrecondition,
        { kind: "object-unreferenced" }
      >;
    }
  | {
      id: string;
      operation: "delete-record-without-object";
      precondition: Extract<
        ArtifactRepairPrecondition,
        { kind: "record-missing-object" }
      >;
    }
  | {
      id: string;
      operation: "remove-invalid-lineage-edge";
      precondition: Extract<
        ArtifactRepairPrecondition,
        { kind: "lineage-edge-invalid" }
      >;
    }
  | {
      id: string;
      operation: "reverify-imported-object";
      precondition: Extract<
        ArtifactRepairPrecondition,
        { kind: "artifact-descriptor-current" }
      >;
    };
export interface ArtifactRepairPlan {
  schema: "mirk-artifact-repair/v1";
  auditId: string;
  createdAt: number;
  actions: readonly ArtifactRepairAction[];
}
export type ArtifactRepairApplyResult =
  | { status: "applied"; actionId: string }
  | {
      status: "conflict";
      actionId: string;
      reason:
        | "state-changed"
        | "reference-created"
        | "object-changed"
        | "lease-unavailable";
    }
  | { status: "not-found"; actionId: string };
export type {
  ArtifactObjectLease,
  ArtifactRepository,
  ArtifactLeaseRepository,
  ArtifactLineageEdge,
  ArtifactDescriptor,
  ListableObjectStore,
  ObjectInfo,
  ObjectStore,
  StoredArtifactRecord,
};
