import { MigrationError } from "./errors.js";
import type { MigrationOptions, MigrationPlanIdentity, MigrationCheckpointV1, MigrationCheckpointV2, MigrationCheckpointUpgradeInput, MigrationResumeValue } from "./types.js";

const batchSize = (value: number | undefined): number => {
  if (value === undefined) return 100;
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new MigrationError("invalid-batch-size", "batchSize must be a positive integer");
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
    throw new MigrationError("invalid-checkpoint", "checkpoint lane must be a non-empty string");
}

function validateProcessed(processed: unknown): asserts processed is number {
  if (
    typeof processed !== "number" ||
    !Number.isSafeInteger(processed) ||
    processed < 0
  ) {
    throw new MigrationError("invalid-checkpoint", "checkpoint processed must be a non-negative safe integer");
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
    throw new MigrationError("invalid-timestamp", `${field} must be a non-negative safe integer`);
  }
}

const validatePlan = (plan: MigrationPlanIdentity): void => {
  if (!isRecord(plan) || plan.schema !== "mirk-migration-plan/v1") {
    throw new MigrationError("invalid-plan", "migration plan schema must be mirk-migration-plan/v1");
  }
  for (const [field, value] of [
    ["planDigest", plan.planDigest],
    ["sourceIdentity", plan.sourceIdentity],
    ["destinationIdentity", plan.destinationIdentity],
  ] as const) {
    if (typeof value !== "string" || value.length === 0) {
      throw new MigrationError("invalid-plan", `migration plan ${field} must be a non-empty string`);
    }
  }
};

function validateCheckpointV1(
  checkpoint: unknown
): asserts checkpoint is MigrationCheckpointV1 {
  if (!isRecord(checkpoint)) throw new MigrationError("invalid-checkpoint", "checkpoint must be an object");
  validateLane(checkpoint.lane);
  validateProcessed(checkpoint.processed);
  if (
    "collection" in checkpoint &&
    checkpoint.collection !== undefined &&
    typeof checkpoint.collection !== "string"
  ) {
    throw new MigrationError("invalid-checkpoint", "checkpoint collection must be a string when provided");
  }
  if (
    checkpoint.collection !== undefined &&
    checkpoint.lane !== `collection:${checkpoint.collection}`
  ) {
    throw new MigrationError("invalid-checkpoint", "checkpoint collection does not match its lane");
  }
}

function validateCheckpointV2(
  checkpoint: unknown
): asserts checkpoint is MigrationCheckpointV2 {
  if (!isRecord(checkpoint)) throw new MigrationError("invalid-checkpoint", "checkpoint must be an object");
  if (!("plan" in checkpoint) || !("updatedAt" in checkpoint)) {
    throw new MigrationError("invalid-checkpoint", "v2 checkpoint must include plan and updatedAt");
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
    throw new MigrationError("invalid-upgrade-input", "checkpoint upgrade input must be an object");
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
    throw new MigrationError("invalid-resume", "resume must include a lane for numeric checkpoints");
  if (isCheckpointObject(resume)) return [{ value: resume }];
  if (Array.isArray(resume)) {
    return resume.map((value) => {
      if (typeof value === "number") {
        throw new MigrationError("invalid-resume", 
          "resume checkpoint lists must contain checkpoint objects"
        );
      }
      return { value: value as MigrationResumeValue };
    });
  }
  if (!isRecord(resume))
    throw new MigrationError("invalid-resume", "resume must be a checkpoint map or checkpoint list");
  const prototype = Object.getPrototypeOf(resume);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new MigrationError("invalid-resume", "resume must be a checkpoint map or checkpoint list");
  }
  return Object.entries(resume).map(([key, value]) => ({
    key,
    value: value as MigrationResumeValue,
  }));
};

export interface PreparedMigration {
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
      throw new MigrationError("mixed-checkpoint-kinds", 
        "resume checkpoints cannot mix numeric, v1, and v2 checkpoint identities"
      );
    }
    kind = nextKind;
    let lane: string;
    let processed: number;
    if (nextKind === "number") {
      if (entry.key === undefined)
        throw new MigrationError("invalid-resume", "numeric resume checkpoints require a lane key");
      validateLane(entry.key);
      validateProcessed(value);
      if (plan !== undefined) {
        throw new MigrationError("v2-checkpoint-required", 
          "plan-bound resume requires v2 checkpoints; convert v1 explicitly first"
        );
      }
      lane = entry.key;
      processed = value;
    } else if (nextKind === "v2") {
      validateCheckpointV2(value);
      if (plan === undefined)
        throw new MigrationError("plan-required", 
          "resuming from a v2 checkpoint requires an explicit plan"
        );
      if (!planMatches(plan, value.plan))
        throw new MigrationError("plan-identity-mismatch", "migration resume plan identity mismatch");
      lane = value.lane;
      processed = value.processed;
    } else {
      validateCheckpointV1(value);
      if (plan !== undefined) {
        throw new MigrationError("v2-checkpoint-required", 
          "plan-bound resume requires v2 checkpoints; convert v1 explicitly first"
        );
      }
      lane = value.lane;
      processed = value.processed;
    }
    if (entry.key !== undefined && entry.key !== lane) {
      throw new MigrationError("lane-key-mismatch", 
        `resume checkpoint lane ${lane} does not match map key ${entry.key}`
      );
    }
    if (normalized.has(lane))
      throw new MigrationError("duplicate-checkpoint-lane", `duplicate resume checkpoint lane ${lane}`);
    normalized.set(lane, processed);
  }
  return normalized;
};

export const prepareMigration = (options: MigrationOptions): PreparedMigration => {
  if (!isRecord(options))
    throw new MigrationError("invalid-options", "migration options must be an object");
  if (
    options.onCheckpoint !== undefined &&
    typeof options.onCheckpoint !== "function"
  ) {
    throw new MigrationError("invalid-options", "onCheckpoint must be a function");
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

export const resumeAt = (prepared: PreparedMigration, lane: string): number =>
  prepared.resume.get(lane) ?? 0;

export const incrementProcessed = (processed: number, amount: number): number => {
  if (processed > Number.MAX_SAFE_INTEGER - amount) {
    throw new MigrationError("processed-count-overflow", "migration processed count exceeds the safe integer range");
  }
  return processed + amount;
};

export const checkpoint = async (
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

