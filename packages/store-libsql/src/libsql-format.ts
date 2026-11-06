import type { InStatement, ResultSet } from "@libsql/client";
import { MIRK_REGISTRY_DDL, VECTOR_FORMAT_DDL, MIRK_SCHEMA_VERSION, schemaVersionTooNewMessage, SELECT_SCHEMA_VERSION_SQL } from "@mirk/store/sql";
interface Executor { execute(statement: InStatement): Promise<ResultSet> }
interface FormatNames {
  meta: string; registry: string; vectors: string; vecMeta: string;
  registrySql(sql: string): string;
}
type FormatFailure = (code: "malformed-schema" | "unsupported-schema-version", message: string) => Error;

/** Create `_mirk_tables` / `_mirk_meta` and pin `schema_version`, refusing a
 *  file written by a newer adapter. Same procedure as @mirk/store/sqlite: the
 *  two adapters read and write each other's files. */
export async function ensureMirkRegistry(db: Executor, names: FormatNames, failure: FormatFailure): Promise<void> {
  const exists = async (name: string): Promise<boolean> => (await db.execute({ sql: "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", args: [name] })).rows.length > 0;
  let version: number | undefined;
  if (await exists(names.meta)) {
    const result = await db.execute(names.registrySql(SELECT_SCHEMA_VERSION_SQL));
    const value = result.rows[0]?.value;
    if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value))) throw failure("malformed-schema", "Malformed Mirk schema version");
    version = Number(value);
    if (version > MIRK_SCHEMA_VERSION) throw failure("unsupported-schema-version", schemaVersionTooNewMessage(value, MIRK_SCHEMA_VERSION));
    if (version !== 1 && version !== 2 && version !== 3) throw failure("unsupported-schema-version", "Unsupported Mirk schema version");
  }
  const sql = (statement: string): string => names.registrySql(statement).replaceAll("_mirk_vector_", names.meta.slice(0, -"_mirk_meta".length) + "_mirk_vector_");
  const spaces = sql("_mirk_vector_spaces");
  const documents = sql("_mirk_vector_documents");
  const values = sql("_mirk_vector_values");
  if (version === 3) {
    for (const table of [names.registry, spaces, documents, values]) {
      if (!(await exists(table))) throw failure("malformed-schema", `Incomplete Mirk format: missing ${table}`);
    }
    for (const [table, columns] of [
      [spaces, ["namespace", "name", "dimensions", "metric", "encoding"]],
      [documents, ["namespace", "collection", "id", "metadata"]],
      [values, ["namespace", "collection", "id", "space", "vec"]],
    ] as const) {
      const info = await db.execute(`PRAGMA table_info(${table})`);
      if (columns.some((name) => !info.rows.some((row) => row.name === name))) throw failure("malformed-schema", `Malformed Mirk table ${table}`);
    }
    return;
  }
  if (version === undefined) {
    const tables = await db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '_mirk_%'");
    if (tables.rows.length > 0 && !(await exists(names.registry))) throw failure("malformed-schema", "Unrecognized unversioned Mirk layout");
  }
  const legacy = await exists(names.vectors);
  const legacyMeta = await exists(names.vecMeta);
  let dimensions: number | undefined;
  if (legacyMeta) {
    const result = await db.execute(`SELECT value FROM ${names.vecMeta} WHERE key='dimensions'`);
    const raw = result.rows[0]?.value;
    if (raw !== undefined) {
      dimensions = Number(raw);
      if (!Number.isSafeInteger(dimensions) || dimensions <= 0) throw failure("malformed-schema", "Malformed legacy vector dimensions");
    }
  }
  if (legacy) {
    const columns = await db.execute(`PRAGMA table_info(${names.vectors})`);
    if (!["collection", "id", "vec", "metadata"].every((name) => columns.rows.some((row) => row.name === name))) throw failure("malformed-schema", "Unrecognized legacy vectors layout");
    const lengths = await db.execute(`SELECT DISTINCT typeof(vec) kind,length(vec) n FROM ${names.vectors}`);
    if (lengths.rows.some((row) => row.kind !== "blob" || Number(row.n) <= 0 || Number(row.n) % 4 !== 0)) throw failure("malformed-schema", "Malformed legacy vector bytes");
    dimensions ??= lengths.rows[0] === undefined ? undefined : Number(lengths.rows[0].n) / 4;
    if (lengths.rows.some((row) => Number(row.n) !== dimensions! * 4)) throw failure("malformed-schema", "Malformed legacy vector dimensions");
  }
  for (const statement of sql(MIRK_REGISTRY_DDL + ";" + VECTOR_FORMAT_DDL).split(";")) {
    if (statement.trim()) await db.execute(statement);
  }
  if (dimensions !== undefined) await db.execute({ sql: `INSERT INTO ${spaces}(namespace,name,dimensions,metric,encoding) VALUES ('default','default',?,'cosine','float32')`, args: [dimensions] });
  if (legacy) {
    await db.execute(`INSERT INTO ${documents}(namespace,collection,id,metadata) SELECT 'default',collection,id,metadata FROM ${names.vectors}`);
    await db.execute(`INSERT INTO ${values}(namespace,collection,id,space,vec) SELECT 'default',collection,id,'default',vec FROM ${names.vectors}`);
    await db.execute(`DROP TABLE ${names.vectors}`);
  }
  if (legacyMeta) await db.execute(`DROP TABLE ${names.vecMeta}`);
  await db.execute({ sql: `INSERT INTO ${names.meta}(key,value) VALUES('schema_version',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, args: [String(MIRK_SCHEMA_VERSION)] });
}

