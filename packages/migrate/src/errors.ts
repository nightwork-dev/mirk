export type MigrationErrorCode =
  | "invalid-vector-manifest"
  | "invalid-batch-size"
  | "invalid-checkpoint"
  | "invalid-timestamp"
  | "invalid-plan"
  | "invalid-upgrade-input"
  | "invalid-resume"
  | "mixed-checkpoint-kinds"
  | "v2-checkpoint-required"
  | "plan-required"
  | "plan-identity-mismatch"
  | "lane-key-mismatch"
  | "duplicate-checkpoint-lane"
  | "invalid-options"
  | "processed-count-overflow"
  | "invalid-verifier"
  | "invalid-collections"
  | "duplicate-collection";

/** Thrown for invalid migration input and checkpoint/resume mismatches. */
export class MigrationError extends Error {
  declare readonly name: "MigrationError";
  readonly code: MigrationErrorCode;

  constructor(code: MigrationErrorCode, message: string) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
    this.code = code;
  }
}
Object.defineProperty(MigrationError.prototype, "name", {
  value: "MigrationError",
  writable: true,
  configurable: true,
  enumerable: false,
});

