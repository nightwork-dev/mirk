import type { ByteSource, ObjectStore } from "@mirk/artifact";
import type {
  AsyncSearchStore,
  AsyncStore,
  AsyncVectorStore,
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

const batchSize = (value: number | undefined): number => {
  if (value === undefined) return 100;
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new Error("batchSize must be a positive integer");
  return value;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isCheckpointObject = (
  value: unknown
): value is MigrationCheckpointV1 | MigrationCheckpointV2 =>
  isRecord(value) &&
  (typeof value.lane === "string" || "plan" in value || "updatedAt" in value);

const isV2Checkpoint = (value: unknown): boolean =>
  isRecord(value) && ("plan" in value || "updatedAt" in value);

function validateLane(lane: unknown): asserts lane is string {
  if (typeof lane !== "string" || lane.length === 0)
    throw new Error("checkpoint lane must be a non-empty string");
}

function validateProcessed(processed: unknown): asserts processed is number {
  if (
    typeof processed !== "number" ||
    !Number.isSafeInteger(processed) ||
    processed < 0
  ) {
    throw new Error("checkpoint processed must be a non-negative safe integer");
  }
}

function validateTimestamp(
  timestamp: unknown,
  field: string
): asserts timestamp is number {
  if (
    typeof timestamp !== "number" ||
    !Number.isSafeInteger(timestamp) ||
    timestamp < 0
  ) {
    throw new Error(`${field} must be a non-negative safe integer`);
  }
}

const validatePlan = (plan: MigrationPlanIdentity): void => {
  if (!isRecord(plan) || plan.schema !== "mirk-migration-plan/v1") {
    throw new Error("migration plan schema must be mirk-migration-plan/v1");
  }
  for (const [field, value] of [
    ["planDigest", plan.planDigest],
    ["sourceIdentity", plan.sourceIdentity],
    ["destinationIdentity", plan.destinationIdentity],
  ] as const) {
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(`migration plan ${field} must be a non-empty string`);
    }
  }
};

function validateCheckpointV1(
  checkpoint: unknown
): asserts checkpoint is MigrationCheckpointV1 {
  if (!isRecord(checkpoint)) throw new Error("checkpoint must be an object");
  validateLane(checkpoint.lane);
  validateProcessed(checkpoint.processed);
  if (
    "collection" in checkpoint &&
    checkpoint.collection !== undefined &&
    typeof checkpoint.collection !== "string"
  ) {
    throw new Error("checkpoint collection must be a string when provided");
  }
  if (
    checkpoint.collection !== undefined &&
    checkpoint.lane !== `collection:${checkpoint.collection}`
  ) {
    throw new Error("checkpoint collection does not match its lane");
  }
}

function validateCheckpointV2(
  checkpoint: unknown
): asserts checkpoint is MigrationCheckpointV2 {
  if (!isRecord(checkpoint)) throw new Error("checkpoint must be an object");
  if (!("plan" in checkpoint) || !("updatedAt" in checkpoint)) {
    throw new Error("v2 checkpoint must include plan and updatedAt");
  }
  validateLane(checkpoint.lane);
  validateProcessed(checkpoint.processed);
  validateTimestamp(checkpoint.updatedAt, "checkpoint updatedAt");
  validatePlan(checkpoint.plan as MigrationPlanIdentity);
}

const planMatches = (
  expected: MigrationPlanIdentity,
  actual: MigrationPlanIdentity
): boolean =>
  expected.schema === actual.schema &&
  expected.planDigest === actual.planDigest &&
  expected.sourceIdentity === actual.sourceIdentity &&
  expected.destinationIdentity === actual.destinationIdentity;

/**
 * Convert an old, unbound checkpoint only when the caller supplies the full
 * plan identity and conversion timestamp. No plan fields are inferred.
 */
export function upgradeCheckpointV1(
  input: MigrationCheckpointUpgradeInput
): MigrationCheckpointV2 {
  if (!isRecord(input))
    throw new Error("checkpoint upgrade input must be an object");
  validateCheckpointV1(input.checkpoint);
  validatePlan(input.plan);
  validateTimestamp(input.convertedAt, "convertedAt");
  return {
    plan: {
      schema: input.plan.schema,
      planDigest: input.plan.planDigest,
      sourceIdentity: input.plan.sourceIdentity,
      destinationIdentity: input.plan.destinationIdentity,
    },
    lane: input.checkpoint.lane,
    processed: input.checkpoint.processed,
    updatedAt: input.convertedAt,
  };
}

type ResumeEntry = { key?: string; value: MigrationResumeValue };

const resumeEntries = (resume: unknown): ResumeEntry[] => {
  if (resume === undefined) return [];
  if (typeof resume === "number")
    throw new Error("resume must include a lane for numeric checkpoints");
  if (isCheckpointObject(resume)) return [{ value: resume }];
  if (Array.isArray(resume)) {
    return resume.map((value) => {
      if (typeof value === "number") {
        throw new Error(
          "resume checkpoint lists must contain checkpoint objects"
        );
      }
      return { value: value as MigrationResumeValue };
    });
  }
  if (!isRecord(resume))
    throw new Error("resume must be a checkpoint map or checkpoint list");
  const prototype = Object.getPrototypeOf(resume);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error("resume must be a checkpoint map or checkpoint list");
  }
  return Object.entries(resume).map(([key, value]) => ({
    key,
    value: value as MigrationResumeValue,
  }));
};

interface PreparedMigration {
  batchSize: number;
  plan?: MigrationPlanIdentity;
  resume: ReadonlyMap<string, number>;
  onCheckpoint: MigrationOptions["onCheckpoint"];
}

const clonePlan = (plan: MigrationPlanIdentity): MigrationPlanIdentity => ({
  schema: plan.schema,
  planDigest: plan.planDigest,
  sourceIdentity: plan.sourceIdentity,
  destinationIdentity: plan.destinationIdentity,
});

const normalizeResume = (
  resume: unknown,
  plan: MigrationPlanIdentity | undefined
): ReadonlyMap<string, number> => {
  const entries = resumeEntries(resume);
  let kind: "number" | "v1" | "v2" | undefined;
  const normalized = new Map<string, number>();
  for (const entry of entries) {
    const value = entry.value;
    const nextKind: NonNullable<typeof kind> =
      typeof value === "number"
        ? "number"
        : isV2Checkpoint(value)
        ? "v2"
        : "v1";
    if (kind !== undefined && kind !== nextKind) {
      throw new Error(
        "resume checkpoints cannot mix numeric, v1, and v2 checkpoint identities"
      );
    }
    kind = nextKind;
    let lane: string;
    let processed: number;
    if (nextKind === "number") {
      if (entry.key === undefined)
        throw new Error("numeric resume checkpoints require a lane key");
      validateLane(entry.key);
      validateProcessed(value);
      if (plan !== undefined) {
        throw new Error(
          "plan-bound resume requires v2 checkpoints; convert v1 explicitly first"
        );
      }
      lane = entry.key;
      processed = value;
    } else if (nextKind === "v2") {
      validateCheckpointV2(value);
      if (plan === undefined)
        throw new Error(
          "resuming from a v2 checkpoint requires an explicit plan"
        );
      if (!planMatches(plan, value.plan))
        throw new Error("migration resume plan identity mismatch");
      lane = value.lane;
      processed = value.processed;
    } else {
      validateCheckpointV1(value);
      if (plan !== undefined) {
        throw new Error(
          "plan-bound resume requires v2 checkpoints; convert v1 explicitly first"
        );
      }
      lane = value.lane;
      processed = value.processed;
    }
    if (entry.key !== undefined && entry.key !== lane) {
      throw new Error(
        `resume checkpoint lane ${lane} does not match map key ${entry.key}`
      );
    }
    if (normalized.has(lane))
      throw new Error(`duplicate resume checkpoint lane ${lane}`);
    normalized.set(lane, processed);
  }
  return normalized;
};

const prepareMigration = (options: MigrationOptions): PreparedMigration => {
  if (!isRecord(options))
    throw new Error("migration options must be an object");
  if (
    options.onCheckpoint !== undefined &&
    typeof options.onCheckpoint !== "function"
  ) {
    throw new Error("onCheckpoint must be a function");
  }
  let plan: MigrationPlanIdentity | undefined;
  if (options.plan !== undefined) {
    const candidatePlan = options.plan as MigrationPlanIdentity;
    validatePlan(candidatePlan);
    plan = clonePlan(candidatePlan);
  }
  return {
    batchSize: batchSize(options.batchSize as number | undefined),
    plan,
    resume: normalizeResume(options.resume, plan),
    onCheckpoint: options.onCheckpoint as MigrationOptions["onCheckpoint"],
  };
};

const resumeAt = (prepared: PreparedMigration, lane: string): number =>
  prepared.resume.get(lane) ?? 0;

const incrementProcessed = (processed: number, amount: number): number => {
  if (processed > Number.MAX_SAFE_INTEGER - amount) {
    throw new Error("migration processed count exceeds the safe integer range");
  }
  return processed + amount;
};

const checkpoint = async (
  prepared: PreparedMigration,
  value: MigrationCheckpointV1
): Promise<void> => {
  if (prepared.onCheckpoint === undefined) {
    return;
  }
  if (prepared.plan === undefined) {
    await prepared.onCheckpoint(value);
    return;
  }
  const updatedAt = Date.now();
  validateTimestamp(updatedAt, "checkpoint updatedAt");
  await prepared.onCheckpoint({
    plan: clonePlan(prepared.plan),
    lane: value.lane,
    processed: value.processed,
    updatedAt,
  });
};

export type MigrationCopy<TResult> =
  | TResult
  | PromiseLike<TResult>
  | (() => TResult | PromiseLike<TResult>);

/** Run a copy operation and a caller-owned, post-copy verification. */
export async function runMigrationWithVerification<TResult>(
  copy: MigrationCopy<TResult>,
  verify: MigrationVerifier<TResult>
): Promise<MigrationVerificationResult<TResult>> {
  if (typeof verify !== "function")
    throw new Error("verify must be a function");
  const result =
    typeof copy === "function"
      ? await (copy as () => TResult | PromiseLike<TResult>)()
      : await copy;
  const verification = await verify(result);
  return { result, verification };
}

const copyCollectionPrepared = async (
  source: AsyncStore,
  destination: AsyncStore,
  collection: string,
  prepared: PreparedMigration
): Promise<number> => {
  const lane = `collection:${collection}`;
  let processed = resumeAt(prepared, lane);

  while (true) {
    const items = await source.list<{ id: string }>(collection, {
      sortBy: "id",
      sortDir: "asc",
      offset: processed,
      limit: prepared.batchSize,
    });
    if (items.length === 0) return processed;
    for (const item of items) await destination.put(collection, item);
    processed = incrementProcessed(processed, items.length);
    await checkpoint(prepared, { lane, collection, processed });
    if (items.length < prepared.batchSize) return processed;
  }
};

export async function copyCollection(
  source: AsyncStore,
  destination: AsyncStore,
  collection: string,
  options: MigrationOptions = {}
): Promise<number> {
  return copyCollectionPrepared(
    source,
    destination,
    collection,
    prepareMigration(options)
  );
}

export async function migrateStore(
  source: AsyncStore,
  destination: AsyncStore,
  collections: readonly string[],
  options: MigrationOptions = {}
): Promise<Record<string, number>> {
  if (!Array.isArray(collections))
    throw new Error("collections must be an array");
  const seenCollections = new Set<string>();
  for (const collection of collections) {
    if (typeof collection !== "string")
      throw new Error("collection must be a string");
    if (seenCollections.has(collection))
      throw new Error(`duplicate migration collection ${collection}`);
    seenCollections.add(collection);
  }
  const prepared = prepareMigration(options);
  const result: Array<[string, number]> = [];
  for (const collection of collections) {
    result.push([
      collection,
      await copyCollectionPrepared(source, destination, collection, prepared),
    ]);
  }
  return Object.fromEntries(result);
}

async function copyManifest<T>(
  lane: string,
  entries: AsyncIterable<T>,
  write: (entry: T) => Promise<unknown>,
  prepared: PreparedMigration
): Promise<number> {
  const start = resumeAt(prepared, lane);
  let seen = 0;
  let processed = start;
  let sinceCheckpoint = 0;

  for await (const entry of entries) {
    if (seen++ < start) continue;
    await write(entry);
    processed = incrementProcessed(processed, 1);
    sinceCheckpoint++;
    if (sinceCheckpoint === prepared.batchSize) {
      await checkpoint(prepared, { lane, processed });
      sinceCheckpoint = 0;
    }
  }
  if (sinceCheckpoint > 0) await checkpoint(prepared, { lane, processed });
  return processed;
}

export const copyVectorManifest = (
  entries: AsyncIterable<VectorManifestEntry>,
  destination: AsyncVectorStore,
  options: MigrationOptions = {}
): Promise<number> => {
  const prepared = prepareMigration(options);
  return copyManifest(
    "vector",
    entries,
    ({ collection, document }) => destination.upsert(collection, document),
    prepared
  );
};

export const copySearchManifest = (
  entries: AsyncIterable<SearchManifestEntry>,
  destination: AsyncSearchStore,
  options: MigrationOptions = {}
): Promise<number> => {
  const prepared = prepareMigration(options);
  return copyManifest(
    "search",
    entries,
    ({ collection, document }) => destination.index(collection, document),
    prepared
  );
};

export const copyGraphManifest = (
  entries: AsyncIterable<GraphManifestEntry>,
  destination: AsyncStore,
  options: MigrationOptions = {}
): Promise<number> => {
  const prepared = prepareMigration(options);
  return copyManifest(
    "graph",
    entries,
    ({ collection, edge }) => destination.put(collection, edge),
    prepared
  );
};

export const copyObjectManifest = (
  entries: AsyncIterable<ObjectManifestEntry>,
  destination: ObjectStore,
  options: MigrationOptions = {}
): Promise<number> => {
  const prepared = prepareMigration(options);
  return copyManifest(
    "object",
    entries,
    ({ key, bytes, mediaType, metadata }) =>
      destination.put(key, bytes, { mediaType, metadata }),
    prepared
  );
};
