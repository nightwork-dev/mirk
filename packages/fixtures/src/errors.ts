import type { Diagnostic, StandardSchemaV1Issue } from "./types.js";

export class FixtureError extends Error {
  declare readonly name: string;
  readonly diagnostic: Diagnostic;

  constructor(diagnostic: Diagnostic) {
    super(diagnostic.message);
    this.diagnostic = diagnostic;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
Object.defineProperty(FixtureError.prototype, "name", {
  value: "FixtureError",
  writable: true,
  configurable: true,
  enumerable: false,
});

export class FixtureValidationError extends FixtureError {
  declare readonly name: "FixtureValidationError";
  readonly issues: ReadonlyArray<StandardSchemaV1Issue>;

  constructor(
    fixture: string,
    source: string,
    path: string,
    issues: ReadonlyArray<StandardSchemaV1Issue>,
  ) {
    super({
      severity: "error",
      code: "schema-invalid",
      message: issues.map((issue) => issue.message).join("; ") || "Schema validation failed.",
      fixture,
      source,
      path,
      fieldPath: issues[0]?.path ? formatIssuePath(issues[0].path) : undefined,
    });
    this.issues = issues;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
Object.defineProperty(FixtureValidationError.prototype, "name", {
  value: "FixtureValidationError",
  writable: true,
  configurable: true,
  enumerable: false,
});

export function diagnosticsFromError(fixture: string | undefined, error: unknown): Diagnostic[] {
  if (error instanceof FixtureValidationError) {
    return error.issues.map((issue) => ({
      severity: "error",
      code: "schema-invalid",
      message: issue.message,
      fixture: error.diagnostic.fixture ?? fixture,
      source: error.diagnostic.source,
      path: error.diagnostic.path,
      fieldPath: issue.path ? formatIssuePath(issue.path) : undefined,
    }));
  }

  if (error instanceof FixtureError) {
    return [{ fixture, ...error.diagnostic }];
  }

  return [{
    severity: "error",
    code: "unknown-error",
    message: error instanceof Error ? error.message : String(error),
    ...(fixture ? { fixture } : {}),
  }];
}

function formatIssuePath(path: ReadonlyArray<PropertyKey | { readonly key: PropertyKey }>): string {
  return path.map((part) => String(typeof part === "object" && part !== null ? part.key : part)).join(".");
}
