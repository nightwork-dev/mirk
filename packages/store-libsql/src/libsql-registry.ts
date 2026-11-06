import type { InStatement, ResultSet } from "@libsql/client";
import {
  COLLECTION_TABLE_PREFIX,
  INSERT_REGISTERED_TABLE_SQL,
  isTableRegistryConflict,
  SELECT_REGISTERED_TABLE_SQL,
  SELECT_TABLE_CLAIM_SQL,
  SELECT_TABLE_EXISTS_SQL,
  tableResolution,
  type TableRegistryAnswer,
} from "@mirk/store/sql";
import type { LibsqlDatabase } from "./libsql-database.js";

// ─── Table names ─────────────────────────────────────────────────────────────

export interface TableNames {
  kv: string;
  registry: string;
  meta: string;
  versions: string;
  sequence: string;
  receipts: string;
  identity: string;
  vecMeta: string;
  vectors: string;
  collectionPrefix: string;
  /** Rewrites a shared registry statement onto the prefixed registry tables. */
  registrySql(sql: string): string;
}

export function tableNames(prefix: string): TableNames {
  const registry = `${prefix}_mirk_tables`;
  const meta = `${prefix}_mirk_meta`;
  return {
    kv: `${prefix}_kv`,
    registry,
    meta,
    versions: `${prefix}_mirk_atomic_versions`,
    sequence: `${prefix}_mirk_atomic_sequence`,
    receipts: `${prefix}_mirk_atomic_receipts`,
    identity: `${prefix}_mirk_atomic_identity`,
    vecMeta: `${prefix}_vec_meta`,
    vectors: `${prefix}vectors`,
    collectionPrefix: `${prefix}${COLLECTION_TABLE_PREFIX}`,
    registrySql: (sql) =>
      prefix === ""
        ? sql
        : sql
            .replaceAll("_mirk_tables", registry)
            .replaceAll("_mirk_meta", meta),
  };
}

// ─── Schema bootstrap ────────────────────────────────────────────────────────

export interface Executor {
  execute(stmt: InStatement): Promise<ResultSet>;
}

/** Async driver for the shared `tableResolution` procedure in @mirk/store/sql —
 *  the same three steps @mirk/store/sqlite runs synchronously. */
export async function runTableResolution(
  db: LibsqlDatabase,
  names: TableNames,
  kind: string,
  name: string,
  register: boolean,
): Promise<string> {
  // A concurrent opener can claim the candidate between this resolution's
  // lookup and its INSERT. Restarting reads the winner's row as a registry hit.
  for (let attempt = 1; ; attempt++) {
    try {
      return await db.transactions.transaction(() =>
        resolveTableOnce(db, names, kind, name, register),
      );
    } catch (err) {
      if (
        attempt >= TABLE_RESOLUTION_ATTEMPTS ||
        !isTableRegistryConflict(err)
      ) {
        throw err;
      }
    }
  }
}

const TABLE_RESOLUTION_ATTEMPTS = 5;

async function resolveTableOnce(
  db: Executor,
  names: TableNames,
  kind: string,
  name: string,
  register: boolean,
): Promise<string> {
  const resolution = tableResolution(
    kind,
    name,
    names.collectionPrefix,
    register,
  );
  let step = resolution.next();
  while (!step.done) {
    const query = step.value;
    let answer: TableRegistryAnswer;
    if (query.q === "registered") {
      const rs = await db.execute({
        sql: names.registrySql(SELECT_REGISTERED_TABLE_SQL),
        args: [query.kind, query.name],
      });
      answer = rs.rows[0]?.table_name as string | undefined;
    } else if (query.q === "claimant") {
      const rs = await db.execute({
        sql: names.registrySql(SELECT_TABLE_CLAIM_SQL),
        args: [query.table],
      });
      answer = rs.rows[0]?.name as string | undefined;
    } else if (query.q === "tableExists") {
      const rs = await db.execute({
        sql: SELECT_TABLE_EXISTS_SQL,
        args: [query.table],
      });
      answer = rs.rows.length > 0;
    } else {
      await db.execute({
        sql: names.registrySql(INSERT_REGISTERED_TABLE_SQL),
        args: [query.kind, query.name, query.table],
      });
    }
    step = resolution.next(answer);
  }
  return step.value;
}
