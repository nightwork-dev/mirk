import {
  mirkFormatMigration,
  SqliteFormatError,
  type SqliteFormatErrorCode,
  type SqliteFormatRows,
  type SqliteMigrationOptions,
  type SqliteMigrationResult,
} from "../sql.js";
import type { SqliteDb } from "./sqlite-driver.js";

type Failure = (code: SqliteFormatErrorCode, message: string) => Error;
export function ensureMirkFormat(
  db: SqliteDb,
  failure: Failure,
  options: SqliteMigrationOptions = {},
  backup?: (path: string) => void,
  explicitInvocation = false,
): SqliteMigrationResult {
  const enteredInTransaction = db.inTransaction;
  const plan = mirkFormatMigration("", options, explicitInvocation);
  let next = plan.next();
  const drain = (): void => {
    while (!next.done) {
      const step = next.value;
      if (step.kind === "begin") {
        next = plan.next([]);
        db.transaction(drain).immediate();
        return;
      }
      if (step.kind === "commit") {
        next = plan.next([]);
        return;
      }
      if (step.kind === "backup") {
        if (enteredInTransaction)
          throw new SqliteFormatError(
            "unsupported-backup",
            "Commit caller transactions before requesting a migration backup",
          );
        if (!backup)
          throw new SqliteFormatError(
            "unsupported-backup",
            "Migration backups require a local file adapter",
          );
        backup(step.path);
        next = plan.next([]);
        continue;
      }
      const rows =
        step.kind === "query"
          ? (db.prepare(step.sql).all(...step.args) as SqliteFormatRows)
          : (db.prepare(step.sql).run(...step.args), []);
      next = plan.next(rows);
    }
  };
  try {
    drain();
    if (!next.done) throw new Error("Incomplete migration plan");
    return next.value;
  } catch (error) {
    if (error instanceof SqliteFormatError)
      throw failure(error.code, error.message);
    if (
      error &&
      typeof error === "object" &&
      (("code" in error && String(error.code).startsWith("SQLITE_READONLY")) ||
        ("errcode" in error && (Number(error.errcode) & 255) === 8))
    )
      throw failure(
        "migration-required",
        "Mirk SQLite file requires a writable format migration",
      );
    throw error;
  }
}
