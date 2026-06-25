import type { Diagnostic, StandardSchemaV1Issue } from "./types.js";

export class FixtureError extends Error {
  readonly diagnostic: Diagnostic;

  constructor(diagnostic: Diagnostic) {
    super(diagnostic.message);
    this.name = "FixtureError";
    this.diagnostic = diagnostic;
  }
}

export class FixtureValidationError extends FixtureError {
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
    this.name = "FixtureValidationError";
    this.issues = issues;
  }
}

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

export function formatIssuePath(path: ReadonlyArray<PropertyKey | { readonly key: PropertyKey }>): string {
  return path.map((part) => String(typeof part === "object" && part !== null ? part.key : part)).join(".");
}
