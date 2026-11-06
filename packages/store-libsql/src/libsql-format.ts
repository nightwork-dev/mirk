import type { InStatement, ResultSet } from "@libsql/client";
import {
  mirkFormatMigration,
  SqliteFormatError,
  type SqliteFormatErrorCode,
  type SqliteMigrationOptions,
  type SqliteMigrationResult,
  type SqliteFormatRows,
} from "@mirk/store/sql";

interface Executor {
  execute(statement: InStatement): Promise<ResultSet>;
}
interface FormatNames {
  meta: string;
}
type FormatFailure = (code: SqliteFormatErrorCode, message: string) => Error;

export async function ensureMirkRegistry(
  db: Executor,
  names: FormatNames,
  failure: FormatFailure,
  options: SqliteMigrationOptions = {},
  backup?: (source: string, destination: string) => void,
): Promise<SqliteMigrationResult> {
  const prefix = names.meta.slice(0, -"_mirk_meta".length);
  const migration = mirkFormatMigration(prefix, options);
  let rows: SqliteFormatRows = [];
  try {
    let step = migration.next(rows);
    for (; !step.done; step = migration.next(rows)) {
      rows = [];
      if (step.value.kind === "backup") {
        if (!backup)
          throw new SqliteFormatError(
            "unsupported-backup",
            "Migration backups require a local file adapter",
          );
        const databases = await db.execute("PRAGMA database_list");
        const source = databases.rows.find((row) => row.name === "main")?.file;
        if (typeof source !== "string" || !source)
          throw new SqliteFormatError(
            "unsupported-backup",
            "Migration backups require a local file database",
          );
        backup(source, step.value.path);
      }
      if (step.value.kind === "query" || step.value.kind === "execute") {
        const result = await db.execute({
          sql: step.value.sql,
          args: [...step.value.args],
        });
        if (step.value.kind === "query") rows = result.rows;
      }
      // The adapter's admitted opening transaction owns begin, commit and rollback.
    }
    return step.value;
  } catch (error) {
    if (error instanceof SqliteFormatError)
      throw failure(error.code, error.message);
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? String(error.code)
        : "";
    if (code.startsWith("SQLITE_READONLY"))
      throw failure(
        "migration-required",
        "Mirk schema migration requires a writable connection",
      );
    throw error;
  }
}
