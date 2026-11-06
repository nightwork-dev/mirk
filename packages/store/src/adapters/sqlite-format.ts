import {
  mirkFormatMigration,
  SqliteFormatError,
  type SqliteFormatErrorCode,
  type SqliteFormatRows,
} from "../sql.js";
import type { SqliteDb } from "./sqlite-driver.js";

type Failure = (code: SqliteFormatErrorCode, message: string) => Error;
export function ensureMirkFormat(db: SqliteDb, failure: Failure): void {
  let transaction = false;
  try {
    const plan = mirkFormatMigration();
    let next = plan.next();
    while (!next.done) {
      const step = next.value;
      let rows: SqliteFormatRows = [];
      if (step.kind === "begin") {
        db.exec("BEGIN IMMEDIATE");
        transaction = true;
      } else if (step.kind === "commit") {
        db.exec("COMMIT");
        transaction = false;
      } else if (step.kind === "query")
        rows = db.prepare(step.sql).all(...step.args) as SqliteFormatRows;
      else db.prepare(step.sql).run(...step.args);
      next = plan.next(rows);
    }
  } catch (error) {
    if (transaction) {
      try {
        db.exec("ROLLBACK");
      } catch {}
    }
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
