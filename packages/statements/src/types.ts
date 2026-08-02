export const STATEMENTS_STORAGE_SCHEMA_VERSION =
  "statements-storage/v1" as const;
export type StatementsStorageSchemaVersion =
  typeof STATEMENTS_STORAGE_SCHEMA_VERSION;

export type StatementId = string;

export interface StatementRef {
  readonly statementId: StatementId;
  readonly worldId: string;
  readonly branchId: string;
}

export interface EntityRef {
  readonly entityId: string;
  readonly kind?: string;
}

export interface PredicateRef {
  readonly predicateId: string;
}

export type Literal =
  | { readonly kind: "string"; readonly value: string }
  | { readonly kind: "number"; readonly value: number }
  | { readonly kind: "boolean"; readonly value: boolean }
  | { readonly kind: "json"; readonly value: unknown };

export interface Proposition {
  readonly subject: EntityRef;
  readonly predicate: PredicateRef;
  readonly object: EntityRef | StatementRef | Literal;
}

export type StatementModality =
  | "fact"
  | "claim"
  | "belief"
  | "rumor"
  | "inference"
  | "rule";
export type StatementPolarity = "positive" | "negative";
export type StatementStatus =
  | "proposed"
  | "accepted"
  | "rejected"
  | "superseded"
  | "retracted";

export type TemporalBound =
  | { readonly kind: "instant"; readonly at: string }
  | { readonly kind: "before"; readonly anchor: { readonly anchorId: string } }
  | { readonly kind: "after"; readonly anchor: { readonly anchorId: string } }
  | { readonly kind: "unbounded" }
  | { readonly kind: "unknown" };

export interface TemporalInterval {
  readonly from: TemporalBound;
  readonly to: TemporalBound;
  readonly precision?: string;
}

export interface RecordedTime {
  readonly kind: "instant";
  readonly at: string;
}

export type ContextKind =
  | "world-version"
  | "campaign"
  | "branch"
  | "hypothetical"
  | "actor-epistemic";

export interface ContextRef {
  readonly kind: ContextKind;
  readonly worldId: string;
  readonly branchId: string;
  readonly campaignId?: string;
  readonly sceneId?: string;
  readonly actorInstanceId?: string;
  readonly applicableTime?: TemporalInterval;
}

export interface NativeStatusLabel {
  readonly packageId: string;
  readonly packageVersion: string;
  readonly label: string;
}

export interface SourceRef {
  readonly sourceId: string;
  readonly anchor?: string;
  readonly nativeStatus?: NativeStatusLabel;
}

export interface StatementOrigin {
  readonly source:
    | "authored"
    | "stated"
    | "tool"
    | "imported"
    | "inferred"
    | "perceived"
    | "consolidated";
  readonly modelInvolved: boolean;
  readonly producer?: {
    readonly componentId: string;
    readonly componentRevision: string;
    readonly modelId?: string;
  };
}

export interface StatementProvenance {
  readonly sources: readonly SourceRef[];
  readonly origin: StatementOrigin;
  readonly activity?: { readonly activityId: string };
}

export interface NumericAnnotation {
  readonly value: number;
  readonly metric: {
    readonly metricId: string;
    readonly revision: string;
  };
}

export interface StatementRecord {
  readonly statementId: StatementId;
  readonly revision: number;
  readonly proposition: Proposition;
  readonly context: ContextRef;
  readonly modality: StatementModality;
  readonly polarity: StatementPolarity;
  readonly validTime?: TemporalInterval;
  readonly recordedTime: RecordedTime;
  readonly status: StatementStatus;
  readonly qualifiers: Readonly<Record<string, unknown>>;
  readonly provenance: StatementProvenance;
  readonly derivedFrom: readonly StatementRef[];
  readonly confidence?: NumericAnnotation;
  readonly supersededBy?: StatementRef;
  readonly admissionReceiptId: string;
}

export interface AuthorizationInputs {
  readonly principalId: string;
  readonly authorityScope: string;
  readonly callerPolicy: string;
}

export interface StatementAdmissionBaseEnvelope {
  readonly auth: AuthorizationInputs;
  readonly idempotencyKey: string;
  readonly worldId: string;
  readonly branchId: string;
  readonly statementId: StatementId;
  readonly recordedAt: string;
  readonly receiptMetadata?: Readonly<Record<string, unknown>>;
}

export interface StatementAdmissionEnvelope
  extends StatementAdmissionBaseEnvelope {
  readonly proposition: Proposition;
  readonly context: ContextRef;
  readonly modality: StatementModality;
  readonly polarity: StatementPolarity;
  readonly status: StatementStatus;
  readonly validTime?: TemporalInterval;
  readonly qualifiers?: Readonly<Record<string, unknown>>;
  readonly provenance: StatementProvenance;
  readonly derivedFrom?: readonly StatementRef[];
  readonly confidence?: NumericAnnotation;
}

export interface StatementRevisionPatch {
  readonly proposition?: Proposition;
  readonly context?: ContextRef;
  readonly modality?: StatementModality;
  readonly polarity?: StatementPolarity;
  readonly status?: StatementStatus;
  readonly validTime?: TemporalInterval;
  readonly qualifiers?: Readonly<Record<string, unknown>>;
  readonly provenance?: StatementProvenance;
  readonly derivedFrom?: readonly StatementRef[];
  readonly confidence?: NumericAnnotation;
  readonly supersededBy?: StatementRef;
}

export interface StatementRevisionEnvelope
  extends StatementAdmissionBaseEnvelope {
  readonly expectedRevision: number;
  readonly patch: StatementRevisionPatch;
}

export interface StatementRetractionEnvelope
  extends StatementAdmissionBaseEnvelope {
  readonly expectedRevision: number;
  readonly provenance: StatementProvenance;
}

export type StatementOperationKind = "admit" | "revise" | "retract";

export type StatementAdmissionRequest =
  | {
      readonly operationKind: "admit";
      readonly envelope: StatementAdmissionEnvelope;
    }
  | {
      readonly operationKind: "revise";
      readonly envelope: StatementRevisionEnvelope;
    }
  | {
      readonly operationKind: "retract";
      readonly envelope: StatementRetractionEnvelope;
    };

export interface StatementAdmissionDecision {
  readonly outcome:
    | {
        readonly kind: "admit";
        readonly status: StatementStatus;
        readonly reason: string;
      }
    | { readonly kind: "refuse"; readonly code: string };
  readonly decidedAt: number;
}

export interface StatementAdmissionAuthority {
  readonly authorityId: string;
  readonly authorityRevision: string;
  decide(
    auth: AuthorizationInputs,
    request: StatementAdmissionRequest
  ): StatementAdmissionDecision;
}

export type StatementReceiptCode =
  | "committed"
  | "authority-refused"
  | "store-refused"
  | "revision-conflict"
  | "idempotency-conflict";

export interface StatementReceipt {
  readonly receiptId: string;
  readonly operationKind: StatementOperationKind;
  readonly authorityScope: string;
  readonly idempotencyKey: string;
  readonly statement: StatementRef;
  readonly code: StatementReceiptCode;
  readonly committedAt: string;
  readonly affected: readonly {
    readonly statement: StatementRef;
    readonly fromRevision?: number;
    readonly toRevision?: number;
    readonly status?: StatementStatus;
  }[];
  readonly refusedBy?: "authority" | "store";
  readonly reason?: string;
  readonly fingerprint: string;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export type StatementOperationResult =
  | {
      readonly ok: true;
      readonly replay: boolean;
      readonly statement: StatementRecord;
      readonly receipt: StatementReceipt;
    }
  | {
      readonly ok: false;
      readonly replay: boolean;
      readonly code: StatementReceiptCode;
      readonly receipt: StatementReceipt;
    };

export interface StatementLensQuery {
  readonly worldId: string;
  readonly branchId: string;
  readonly contextKind?: ContextKind;
  readonly actorInstanceId?: string;
  readonly statuses?: readonly StatementStatus[];
  readonly modalities?: readonly StatementModality[];
  readonly sourceIds?: readonly string[];
  readonly validAt?: string;
  readonly recordedFrom?: string;
  readonly recordedTo?: string;
  readonly limit?: number;
}

export interface LegacyStatementSurface<TLegacy> {
  readonly name: string;
  read(): Iterable<TLegacy>;
  toStatement(record: TLegacy): StatementRecord;
}

export interface DualReadParityIssue {
  readonly statement: StatementRef;
  readonly field: string;
  readonly legacyValue: unknown;
  readonly canonicalValue: unknown;
}

export interface DualReadParityReport {
  readonly legacySurfaceName: string;
  readonly checked: number;
  readonly missingCanonical: readonly StatementRef[];
  readonly issues: readonly DualReadParityIssue[];
}

export interface StatementBackfillState {
  readonly backfillId: string;
  readonly sourceName: string;
  readonly cursor?: unknown;
  readonly status: "running" | "complete" | "failed";
  readonly updatedAt: string;
}
