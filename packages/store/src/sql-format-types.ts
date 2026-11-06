/** The `_mirk_meta.schema_version` this build writes and understands. */
export const MIRK_SCHEMA_VERSION = 4;

export const MIRK_REGISTRY_DDL = `
  CREATE TABLE IF NOT EXISTS _mirk_tables (
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    table_name TEXT NOT NULL UNIQUE,
    PRIMARY KEY (kind, name)
  );
  CREATE TABLE IF NOT EXISTS _mirk_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`;

export const VECTOR_FORMAT_DDL = `
CREATE TABLE IF NOT EXISTS _mirk_vector_spaces (
 namespace TEXT NOT NULL, name TEXT NOT NULL, dimensions INTEGER NOT NULL CHECK(dimensions>0),
 metric TEXT NOT NULL CHECK(metric='cosine'), encoding TEXT NOT NULL CHECK(encoding='float32'), PRIMARY KEY(namespace,name));
CREATE TABLE IF NOT EXISTS _mirk_vector_documents (
 namespace TEXT NOT NULL, collection TEXT NOT NULL, id TEXT NOT NULL, metadata TEXT, PRIMARY KEY(namespace,collection,id));
CREATE TABLE IF NOT EXISTS _mirk_vector_values (
 namespace TEXT NOT NULL, collection TEXT NOT NULL, id TEXT NOT NULL, space TEXT NOT NULL, vec BLOB NOT NULL,
 PRIMARY KEY(namespace,collection,id,space),
 FOREIGN KEY(namespace,collection,id) REFERENCES _mirk_vector_documents(namespace,collection,id) ON DELETE CASCADE,
 FOREIGN KEY(namespace,space) REFERENCES _mirk_vector_spaces(namespace,name));`;

export type SqliteFormatRows = Record<string, unknown>[];
export type SqliteFormatStep =
  | {
      kind: "query" | "execute";
      sql: string;
      args: readonly (string | number)[];
    }
  | { kind: "begin" }
  | { kind: "commit" }
  | { kind: "backup"; path: string };
export type SqliteFormatErrorCode =
  | "unsupported-schema-version"
  | "malformed-schema"
  | "migration-required"
  | "migration-refused"
  | "unsupported-backup"
  | "backup-failed";
export class SqliteFormatError extends Error {
  constructor(
    readonly code: SqliteFormatErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SqliteFormatError";
  }
}

export type Plan<T = void> = Generator<SqliteFormatStep, T, SqliteFormatRows>;
export const malformed = (message: string): never => {
  throw new SqliteFormatError("malformed-schema", message);
};
export function* query(
  sql: string,
  ...args: (string | number)[]
): Plan<SqliteFormatRows> {
  return yield { kind: "query", sql, args };
}
export function* execute(sql: string, ...args: (string | number)[]): Plan {
  yield { kind: "execute", sql, args };
}

/** One migration policy; drivers supply queries and writer admission, and roll back on failure. */
export interface SqliteMigrationResult {
  fromVersion: number | null;
  toVersion: number;
  changed: boolean;
  backupPath?: string;
}
export interface SqliteMigrationOptions {
  migration?: "auto" | "explicit" | "refuse";
  backupPath?: string;
  legacyVectorSpace?: string;
}
