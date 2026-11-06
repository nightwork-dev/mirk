import {
  mirkFormatMigration,
  SqliteFormatError,
  type SqliteFormatErrorCode,
  type SqliteFormatRows,
} from "../sql.js";
import type { SqliteDb } from "./sqlite-driver.js";

type Failure = (code: SqliteFormatErrorCode, message: string) => Error;
export function ensureMirkFormat(db: SqliteDb, failure: Failure): void {
  const plan = mirkFormatMigration();
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
      const rows =
        step.kind === "query"
          ? (db.prepare(step.sql).all(...step.args) as SqliteFormatRows)
          : (db.prepare(step.sql).run(...step.args), []);
      next = plan.next(rows);
    }
  };
  try {
    drain();
  } catch (error) {
    if (error instanceof SqliteFormatError)
      throw failure(error.code, error.message);
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      String(error.code).startsWith("SQLITE_READONLY")
    )
      throw failure(
        "migration-required",
        "Mirk SQLite file requires a writable format migration",
      );
    throw error;
  }
}
