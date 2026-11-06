import type { ByteSource } from "@mirk/artifact";
import type {
  Edge,
  SearchDocument,
  VectorDocument,
} from "@mirk/store";

/** The unbound checkpoint shape emitted by the original migration API. */
export interface MigrationCheckpointV1 {
  lane: string;
  processed: number;
  collection?: string;
}

export interface MigrationPlanIdentity {
  schema: "mirk-migration-plan/v1";
  planDigest: string;
  sourceIdentity: string;
  destinationIdentity: string;
}

export interface MigrationCheckpointV2 {
  plan: MigrationPlanIdentity;
  lane: string;
  processed: number;
  updatedAt: number;
  /** Kept optional so callbacks typed against the v1 checkpoint stay assignable. */
  collection?: string;
}

export interface MigrationCheckpointUpgradeInput {
  checkpoint: MigrationCheckpointV1;
  plan: MigrationPlanIdentity;
  convertedAt: number;
}

export interface MigrationVerificationDiagnostic {
  code: string;
  message: string;
  locator?: string;
}

export interface MigrationVerification {
  ok: boolean;
  checked: number;
  diagnostics: readonly MigrationVerificationDiagnostic[];
}

export interface MigrationVerificationResult<TResult> {
  result: TResult;
  verification: MigrationVerification;
}

export type MigrationVerifier<TResult = unknown> = (
  result: TResult
) => MigrationVerification | Promise<MigrationVerification>;

export type MigrationResumeValue =
  | number
  | MigrationCheckpointV1
  | MigrationCheckpointV2;

export type MigrationResume =
  | Readonly<Record<string, MigrationResumeValue>>
  | readonly (MigrationCheckpointV1 | MigrationCheckpointV2)[]
  | MigrationCheckpointV1
  | MigrationCheckpointV2;

export interface MigrationOptions {
  batchSize?: number;
  /** A plan opts into plan-bound v2 checkpoints. */
  plan?: MigrationPlanIdentity;
  /** Numeric and v1 values retain the original unbound resume behavior. */
  resume?: MigrationResume;
  onCheckpoint?: (
    checkpoint: MigrationCheckpointV1 | MigrationCheckpointV2
  ) => void | Promise<void>;
}

export interface VectorManifestEntry {
  collection: string;
  document: VectorDocument;
}

export interface SearchManifestEntry {
  collection: string;
  document: SearchDocument;
}

export interface GraphManifestEntry {
  collection: string;
  edge: Edge;
}

export interface ObjectManifestEntry {
  key: string;
  bytes: ByteSource;
  mediaType?: string;
  metadata?: Record<string, string>;
}

