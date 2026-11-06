import type { InStatement, ResultSet } from "@libsql/client";
import { mirkFormatMigration, SqliteFormatError, type SqliteFormatErrorCode, type SqliteFormatRows } from "@mirk/store/sql";

interface Executor { execute(statement: InStatement): Promise<ResultSet> }
interface FormatNames { meta: string }
type FormatFailure = (code: SqliteFormatErrorCode, message: string) => Error;

export async function ensureMirkRegistry(db: Executor, names: FormatNames, failure: FormatFailure): Promise<void> {
  const prefix = names.meta.slice(0, -"_mirk_meta".length);
  const migration = mirkFormatMigration(prefix);
  let rows: SqliteFormatRows = [];
  try {
    for (let step = migration.next(rows); !step.done; step = migration.next(rows)) {
      rows = [];
      if (step.value.kind === "query" || step.value.kind === "execute") {
        const result = await db.execute({ sql: step.value.sql, args: [...step.value.args] });
        if (step.value.kind === "query") rows = result.rows;
      }
      // The adapter's admitted opening transaction owns begin, commit and rollback.
    }
  } catch (error) {
    if (error instanceof SqliteFormatError) throw failure(error.code, error.message);
    const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
    if (code.startsWith("SQLITE_READONLY")) throw failure("migration-required", "Mirk schema migration requires a writable connection");
    throw error;
  }
}
