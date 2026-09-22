export type ArtifactValidationErrorCode =
  | "invalid-object-key"
  | "object-key-escapes-root"
  | "invalid-byte-chunk"
  | "invalid-media-type"
  | "invalid-producer"
  | "non-json-metadata"
  | "non-finite-metadata"
  | "invalid-concurrency-config";

export class ArtifactValidationError extends TypeError {
  declare readonly name: "ArtifactValidationError";
  constructor(readonly code: ArtifactValidationErrorCode, message: string) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
Object.defineProperty(ArtifactValidationError.prototype, "name", {
  value: "ArtifactValidationError",
  writable: true,
  configurable: true,
  enumerable: false,
});

export type ArtifactLimitErrorCode = "metadata-too-large" | "metadata-too-deep";

export class ArtifactLimitError extends RangeError {
  declare readonly name: "ArtifactLimitError";
  constructor(readonly code: ArtifactLimitErrorCode, message: string) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
Object.defineProperty(ArtifactLimitError.prototype, "name", {
  value: "ArtifactLimitError",
  writable: true,
  configurable: true,
  enumerable: false,
});

export type ArtifactOperationErrorCode =
  | "invalid-cursor"
  | "missing-lineage-endpoint"
  | "artifact-not-found"
  | "object-not-found"
  | "artifact-object-missing"
  | "object-deletion-failed"
  | "lease-lost"
  | "lease-commit-unsupported"
  | "atomic-mutation-unavailable"
  | "web-crypto-unavailable";

export class ArtifactOperationError extends Error {
  declare readonly name: "ArtifactOperationError";
  constructor(readonly code: ArtifactOperationErrorCode, message: string) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
Object.defineProperty(ArtifactOperationError.prototype, "name", {
  value: "ArtifactOperationError",
  writable: true,
  configurable: true,
  enumerable: false,
});
