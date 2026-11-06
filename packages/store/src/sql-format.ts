/** The `_mirk_meta.schema_version` this build writes and understands. */
export const MIRK_SCHEMA_VERSION = 3;

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
  | { kind: "commit" };
export type SqliteFormatErrorCode =
  | "unsupported-schema-version"
  | "malformed-schema"
  | "migration-required";
export class SqliteFormatError extends Error {
  constructor(
    readonly code: SqliteFormatErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SqliteFormatError";
  }
}

type Plan<T = void> = Generator<SqliteFormatStep, T, SqliteFormatRows>;
const malformed = (message: string): never => {
  throw new SqliteFormatError("malformed-schema", message);
};
function* query(
  sql: string,
  ...args: (string | number)[]
): Plan<SqliteFormatRows> {
  return yield { kind: "query", sql, args };
}
function* execute(sql: string, ...args: (string | number)[]): Plan {
  yield { kind: "execute", sql, args };
}

/** One migration policy; drivers supply queries and writer admission, and roll back on failure. */
export function* mirkFormatMigration(tablePrefix = ""): Plan {
  if (tablePrefix && !/^[A-Za-z][A-Za-z0-9_]{0,47}$/.test(tablePrefix))
    throw new TypeError("Invalid SQLite table prefix");
  const table = (name: string) => `${tablePrefix}${name}`;
  function* exists(name: string): Plan<boolean> {
    return (
      (yield* query(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",
        table(name),
      )).length > 0
    );
  }
  function* columns(name: string): Plan<string[]> {
    return (yield* query(`PRAGMA table_info(${table(name)})`)).map((row) =>
      String(row.name),
    );
  }
  function* version(): Plan<number | null> {
    if (!(yield* exists("_mirk_meta"))) return null;
    const rows = yield* query(
      `SELECT value FROM ${table("_mirk_meta")} WHERE key='schema_version'`,
    );
    const found = rows[0]?.value;
    if (
      rows.length !== 1 ||
      typeof found !== "string" ||
      !/^[1-9][0-9]*$/.test(found)
    )
      malformed("Malformed Mirk schema version");
    const value = Number(found);
    if (!Number.isSafeInteger(value))
      malformed("Malformed Mirk schema version");
    if (value > MIRK_SCHEMA_VERSION)
      throw new SqliteFormatError(
        "unsupported-schema-version",
        `Mirk SQLite file schema version ${value} is newer than this adapter understands (${MIRK_SCHEMA_VERSION}).`,
      );
    return value;
  }
  function* validateCurrent(): Plan {
    const required: Record<string, string[]> = {
      _mirk_tables: ["kind", "name", "table_name"],
      _mirk_vector_spaces: [
        "namespace",
        "name",
        "dimensions",
        "metric",
        "encoding",
      ],
      _mirk_vector_documents: ["namespace", "collection", "id", "metadata"],
      _mirk_vector_values: ["namespace", "collection", "id", "space", "vec"],
    };
    for (const [name, expected] of Object.entries(required)) {
      if (!(yield* exists(name)))
        malformed(`Missing Mirk table ${table(name)}`);
      const actual = yield* columns(name);
      if (!expected.every((column) => actual.includes(column)))
        malformed(`Malformed Mirk table ${table(name)}`);
    }
  }
  if ((yield* version()) === MIRK_SCHEMA_VERSION) {
    yield* validateCurrent();
    return;
  }
  yield { kind: "begin" };
  const found = yield* version();
  if (found === MIRK_SCHEMA_VERSION) {
    yield* validateCurrent();
    yield { kind: "commit" };
    return;
  }
  if (found !== null && found !== 1 && found !== 2)
    malformed("Unsupported legacy Mirk format");
  if (found === null) {
    const legacy: Record<string, string[]> = {
      _mirk_tables: ["kind", "name", "table_name"],
      _mirk_atomic_versions: ["kind", "collection", "target_key", "version"],
      _mirk_atomic_sequence: ["id", "value"],
      _mirk_atomic_identity: ["id", "value"],
      _mirk_atomic_receipts: [
        "idempotency_key",
        "request_digest",
        "result_json",
      ],
      _mirk_log: ["stream", "sequence", "record"],
      _mirk_search_schema: ["collection", "fields_json"],
    };
    const rows = yield* query(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
    );
    for (const row of rows) {
      const physical = String(row.name);
      if (
        !physical.startsWith(table("_mirk_")) ||
        physical.startsWith(table("_mirk_coordination_"))
      )
        continue;
      const name = physical.slice(tablePrefix.length);
      const expected =
        legacy[name] ?? malformed("Unrecognized unversioned Mirk layout");
      const actual = yield* columns(name);
      if (!expected.every((column) => actual.includes(column)))
        malformed("Unrecognized unversioned Mirk layout");
    }
  }
  let dimensions: number | undefined;
  const hasMeta = yield* exists("_vec_meta");
  const hasVectors = yield* exists("vectors");
  if (hasMeta) {
    const row = (yield* query(
      `SELECT value FROM ${table("_vec_meta")} WHERE key='dimensions'`,
    ))[0];
    if (row) {
      if (typeof row.value !== "string" || !/^[1-9][0-9]*$/.test(row.value))
        malformed("Invalid legacy vector dimensions");
      dimensions = Number(row.value);
      if (!Number.isSafeInteger(dimensions))
        malformed("Invalid legacy vector dimensions");
    }
  }
  if (hasVectors) {
    const actual = yield* columns("vectors");
    if (
      !["collection", "id", "vec", "metadata"].every((name) =>
        actual.includes(name),
      )
    )
      malformed("Unrecognized legacy vectors layout");
    const lengthRows = yield* query(
      `SELECT DISTINCT length(vec) AS n, typeof(vec) AS kind FROM ${table("vectors")}`,
    );
    const lengths = lengthRows.map((row) => ({
      n: Number(row.n),
      kind: row.kind,
    }));
    if (
      lengths.some(
        (row) =>
          row.kind !== "blob" ||
          typeof row.n !== "number" ||
          row.n <= 0 ||
          row.n % 4 !== 0,
      )
    )
      malformed("Invalid legacy vector BLOB");
    if (dimensions === undefined && lengths.length)
      dimensions = Number(lengths[0]!.n) / 4;
    if (lengths.some((row) => row.n !== dimensions! * 4))
      malformed("Legacy vector dimensions do not match BLOB lengths");
  }
  const ddl = `${MIRK_REGISTRY_DDL}\n${VECTOR_FORMAT_DDL}`.replace(
    /\b_mirk_[a-z_]+\b/g,
    table,
  );
  for (const statement of ddl.split(";"))
    if (statement.trim()) yield* execute(statement);
  if (dimensions !== undefined)
    yield* execute(
      `INSERT INTO ${table("_mirk_vector_spaces")} VALUES('default','default',?,'cosine','float32')`,
      dimensions,
    );
  if (hasVectors) {
    yield* execute(
      `INSERT INTO ${table("_mirk_vector_documents")}(namespace,collection,id,metadata) SELECT 'default',collection,id,metadata FROM ${table("vectors")}`,
    );
    yield* execute(
      `INSERT INTO ${table("_mirk_vector_values")}(namespace,collection,id,space,vec) SELECT 'default',collection,id,'default',vec FROM ${table("vectors")}`,
    );
    yield* execute(`DROP TABLE ${table("vectors")}`);
  }
  if (hasMeta) yield* execute(`DROP TABLE ${table("_vec_meta")}`);
  yield* execute(
    `INSERT INTO ${table("_mirk_meta")}(key,value) VALUES('schema_version',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
    String(MIRK_SCHEMA_VERSION),
  );
  yield { kind: "commit" };
}
