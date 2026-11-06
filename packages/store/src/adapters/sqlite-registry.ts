import { type SqliteDb } from "./sqlite-driver.js";
import {
  INSERT_REGISTERED_TABLE_SQL,
  isTableRegistryConflict,
  SELECT_REGISTERED_TABLE_SQL,
  SELECT_TABLE_CLAIM_SQL,
  SELECT_TABLE_EXISTS_SQL,
  tableResolution,
  type TableRegistryAnswer,
} from "../sql.js";
/** Synchronous driver for the shared `tableResolution` procedure in ../sql.ts.
 *  The procedure itself lives there because @mirk/store-libsql runs the exact
 *  same steps against an async client. */
export function runTableResolution(
  db: SqliteDb,
  kind: string,
  name: string,
  prefix: string,
  register: boolean,
): string {
  // A concurrent opener can claim the candidate between this resolution's
  // lookup and its INSERT. Restarting reads the winner's row as a registry hit.
  for (let attempt = 1; ; attempt++) {
    try {
      return resolveTableOnce(db, kind, name, prefix, register);
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

function resolveTableOnce(
  db: SqliteDb,
  kind: string,
  name: string,
  prefix: string,
  register: boolean,
): string {
  const resolution = tableResolution(kind, name, prefix, register);
  let step = resolution.next();
  while (!step.done) {
    const query = step.value;
    let answer: TableRegistryAnswer;
    if (query.q === "registered") {
      answer = (
        db.prepare(SELECT_REGISTERED_TABLE_SQL).get(query.kind, query.name) as
          | { table_name: string }
          | undefined
      )?.table_name;
    } else if (query.q === "claimant") {
      answer = (
        db.prepare(SELECT_TABLE_CLAIM_SQL).get(query.table) as
          | { name: string }
          | undefined
      )?.name;
    } else if (query.q === "tableExists") {
      answer =
        db.prepare(SELECT_TABLE_EXISTS_SQL).get(query.table) !== undefined;
    } else {
      db.prepare(INSERT_REGISTERED_TABLE_SQL).run(
        query.kind,
        query.name,
        query.table,
      );
    }
    step = resolution.next(answer);
  }
  return step.value;
}
