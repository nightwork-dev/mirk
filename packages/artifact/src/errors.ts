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
  | "object-key-occupied"
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

/** Thrown by an object store when a write failed after its bytes may have
 *  reached the store, so it cannot prove whether the object now at `key` is
 *  this writer's; a remote upload can succeed before its reply is lost. The
 *  coordinator keeps the object instead of deleting bytes that may belong to
 *  another writer. A retry under the same id adopts identical bytes, and
 *  `ArtifactMaintenance` finds any other leftover as `object-without-record`
 *  and removes it with `delete-unreferenced-object`. */
export class ObjectWriteIndeterminateError extends Error {
  declare readonly name: "ObjectWriteIndeterminateError";
  constructor(readonly key: string, options?: ErrorOptions) {
    super(
      "Object write outcome is indeterminate; the object is kept. A retry with the same bytes adopts it; ArtifactMaintenance removes it if nothing does.",
      options
    );
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
Object.defineProperty(ObjectWriteIndeterminateError.prototype, "name", {
  value: "ObjectWriteIndeterminateError",
  writable: true,
  configurable: true,
  enumerable: false,
});
