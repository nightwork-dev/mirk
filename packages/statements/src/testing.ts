import type {
  DualReadParityIssue,
  DualReadParityReport,
  LegacyStatementSurface,
  StatementRecord,
  StatementRef,
} from "./types.js";
import type { SqliteStatementStore } from "./sqlite.js";

export function compareLegacySurface<TLegacy>(
  store: SqliteStatementStore,
  surface: LegacyStatementSurface<TLegacy>
): DualReadParityReport {
  const missingCanonical: StatementRef[] = [];
  const issues: DualReadParityIssue[] = [];
  let checked = 0;

  for (const legacy of surface.read()) {
    checked += 1;
    const expected = surface.toStatement(legacy);
    const ref = refFor(expected);
    const actual = store.getRevision(ref, expected.revision);
    if (!actual) {
      missingCanonical.push(ref);
      continue;
    }
    compareRecord(ref, issues, "status", expected.status, actual.status);
    compareRecord(ref, issues, "modality", expected.modality, actual.modality);
    compareRecord(ref, issues, "polarity", expected.polarity, actual.polarity);
    compareRecord(ref, issues, "context", expected.context, actual.context);
    compareRecord(
      ref,
      issues,
      "proposition",
      expected.proposition,
      actual.proposition
    );
    compareRecord(
      ref,
      issues,
      "provenance",
      expected.provenance,
      actual.provenance
    );
  }

  return {
    legacySurfaceName: surface.name,
    checked,
    missingCanonical,
    issues,
  };
}

function refFor(record: StatementRecord): StatementRef {
  return {
    statementId: record.statementId,
    worldId: record.context.worldId,
    branchId: record.context.branchId,
  };
}

function compareRecord(
  statement: StatementRef,
  issues: DualReadParityIssue[],
  field: string,
  legacyValue: unknown,
  canonicalValue: unknown
): void {
  if (JSON.stringify(legacyValue) === JSON.stringify(canonicalValue)) return;
  issues.push({ statement, field, legacyValue, canonicalValue });
}
