import { systemClock } from "./core.js";
import Database from "better-sqlite3";
import type { CoordinationOptions } from "./core.js";
import { isSqliteBusyOrLocked, runSqliteBusyRetry } from "../sqlite-busy.js";
import {
  LeaseCoordinator,
  type LeaseBackend,
  type LeaseIdentity,
} from "./engine.js";

export interface SqliteCoordinatorOptions extends CoordinationOptions {
  path: string;
  busyTimeoutMs?: number;
}
interface LeaseRow {
  owner_token: string;
  fencing_generation: number;
  expires_at_ms: number;
}

export function createSqliteCoordinator(
  options: SqliteCoordinatorOptions,
): SqliteCoordinator {
  return new SqliteCoordinator(options);
}
export class SqliteCoordinator extends LeaseCoordinator {
  readonly #db: Database.Database;
  constructor(options: SqliteCoordinatorOptions) {
    if (!options.path)
      throw new Error("SqliteCoordinator requires a database path.");
    const busy = options.busyTimeoutMs ?? 30_000;
    if (!Number.isSafeInteger(busy) || busy < 0)
      throw new Error("busyTimeoutMs must be a non-negative safe integer.");
    const db = new Database(options.path, { timeout: 0 });
    const namespace = options.namespace ?? "default";
    const clock = options.clock ?? systemClock;
    try {
      runSqliteBusyRetry(
        () => {
          db.transaction(() => {
            const meta = db
              .prepare(
                "SELECT name FROM sqlite_master WHERE type='table' AND name='_mirk_coordination_meta'",
              )
              .get();
            if (meta) {
              const columns = db
                .prepare("PRAGMA table_info(_mirk_coordination_meta)")
                .all() as {
                name: string;
                type: string;
                notnull: number;
                pk: number;
              }[];
              if (
                columns.length !== 1 ||
                columns[0]!.name !== "schema_version" ||
                columns[0]!.type.toUpperCase() !== "INTEGER" ||
                columns[0]!.notnull !== 1 ||
                columns[0]!.pk !== 0
              )
                throw new Error("Malformed coordination schema metadata.");
              const versions = db
                .prepare("SELECT schema_version FROM _mirk_coordination_meta")
                .all() as { schema_version: unknown }[];
              if (versions.length !== 1 || versions[0]!.schema_version !== 1)
                throw new Error("Unsupported coordination schema version.");
            }
            const layouts: Record<string, string[]> = {
              _mirk_coordination_generations: [
                "namespace",
                "key",
                "last_generation",
              ],
              _mirk_coordination_leases: [
                "namespace",
                "key",
                "owner_token",
                "fencing_generation",
                "acquired_at_ms",
                "expires_at_ms",
                "updated_at_ms",
              ],
            };
            let present = 0;
            for (const [table, names] of Object.entries(layouts)) {
              const columns = db
                .prepare(`PRAGMA table_info(${table})`)
                .all() as {
                name: string;
                type: string;
                notnull: number;
                pk: number;
              }[];
              if (!columns.length) continue;
              present++;
              if (
                columns.length !== names.length ||
                columns.some(
                  (column, i) =>
                    column.name !== names[i] ||
                    column.notnull !== 1 ||
                    column.type.toUpperCase() !==
                      (i < 2 || column.name === "owner_token"
                        ? "TEXT"
                        : "INTEGER") ||
                    column.pk !== (i < 2 ? i + 1 : 0),
                )
              )
                throw new Error("Unrecognized coordination schema layout.");
            }
            if (present === 1)
              throw new Error("Incomplete coordination schema layout.");
            if (present === 2) {
              const invalid = db
                .prepare(
                  `SELECT 1 FROM _mirk_coordination_leases l LEFT JOIN _mirk_coordination_generations g ON g.namespace=l.namespace AND g.key=l.key WHERE g.last_generation IS NULL OR g.last_generation < l.fencing_generation OR l.fencing_generation < 1 LIMIT 1`,
                )
                .get();
              const invalidGeneration = db
                .prepare(
                  "SELECT 1 FROM _mirk_coordination_generations WHERE typeof(last_generation) != 'integer' OR last_generation < 1 OR last_generation > 9007199254740991 LIMIT 1",
                )
                .get();
              if (invalid || invalidGeneration)
                throw new Error("Invalid coordination generation history.");
            }
            db.exec(`
            CREATE TABLE IF NOT EXISTS _mirk_coordination_meta (schema_version INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS _mirk_coordination_generations (
              namespace TEXT NOT NULL, key TEXT NOT NULL, last_generation INTEGER NOT NULL,
              PRIMARY KEY (namespace, key));
            CREATE TABLE IF NOT EXISTS _mirk_coordination_leases (
              namespace TEXT NOT NULL, key TEXT NOT NULL, owner_token TEXT NOT NULL,
              fencing_generation INTEGER NOT NULL, acquired_at_ms INTEGER NOT NULL,
              expires_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL,
              PRIMARY KEY (namespace, key));
          `);
            if (!meta)
              db.prepare(
                "INSERT INTO _mirk_coordination_meta VALUES (1)",
              ).run();
          }).immediate();
        },
        busy,
        5,
        50,
      );
    } catch (error) {
      db.close();
      throw error;
    }
    const current = (lease: LeaseIdentity): LeaseRow | undefined =>
      db
        .prepare(
          "SELECT owner_token, fencing_generation, expires_at_ms FROM _mirk_coordination_leases WHERE namespace = ? AND key = ?",
        )
        .get(namespace, lease.key) as LeaseRow | undefined;
    const owned = (lease: LeaseIdentity) => {
      const row = current(lease);
      return Boolean(
        row &&
          row.owner_token === lease.ownerToken &&
          row.fencing_generation === lease.fencingGeneration &&
          row.expires_at_ms > clock.now(),
      );
    };
    const nonblocking = <T>(work: () => T): T | "unavailable" => {
      try {
        return work();
      } catch (error) {
        if (isSqliteBusyOrLocked(error)) return "unavailable";
        throw error;
      }
    };
    const backend: LeaseBackend = {
      acquire(key, token, leaseMs) {
        try {
          return db
            .transaction(() => {
              const now = clock.now();
              const row = db
                .prepare(
                  "SELECT owner_token, fencing_generation, expires_at_ms FROM _mirk_coordination_leases WHERE namespace = ? AND key = ?",
                )
                .get(namespace, key) as LeaseRow | undefined;
              if (row && row.expires_at_ms > now)
                return {
                  status: "held" as const,
                  expiresAt: row.expires_at_ms,
                };
              const generation = db
                .prepare(
                  "SELECT last_generation FROM _mirk_coordination_generations WHERE namespace = ? AND key = ?",
                )
                .get(namespace, key) as { last_generation: number } | undefined;
              const fencingGeneration = (generation?.last_generation ?? 0) + 1;
              if (!Number.isSafeInteger(fencingGeneration))
                throw new Error("Coordination fencing generation exhausted.");
              db.prepare(
                "INSERT INTO _mirk_coordination_generations VALUES (?, ?, ?) ON CONFLICT(namespace, key) DO UPDATE SET last_generation = excluded.last_generation",
              ).run(namespace, key, fencingGeneration);
              db.prepare(
                `INSERT INTO _mirk_coordination_leases VALUES (?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(namespace, key) DO UPDATE SET owner_token=excluded.owner_token,
              fencing_generation=excluded.fencing_generation, acquired_at_ms=excluded.acquired_at_ms,
              expires_at_ms=excluded.expires_at_ms, updated_at_ms=excluded.updated_at_ms`,
              ).run(
                namespace,
                key,
                token,
                fencingGeneration,
                now,
                now + leaseMs,
                now,
              );
              return {
                status: "acquired" as const,
                fencingGeneration,
                expiresAt: now + leaseMs,
              };
            })
            .immediate();
        } catch (error) {
          if (isSqliteBusyOrLocked(error))
            return { status: "unavailable", retryable: true };
          throw error;
        }
      },
      renew(lease, leaseMs) {
        return nonblocking(() => {
          const now = clock.now();
          const result = db
            .prepare(
              `UPDATE _mirk_coordination_leases SET expires_at_ms=?, updated_at_ms=?
          WHERE namespace=? AND key=? AND owner_token=? AND fencing_generation=? AND expires_at_ms>?`,
            )
            .run(
              now + leaseMs,
              now,
              namespace,
              lease.key,
              lease.ownerToken,
              lease.fencingGeneration,
              now,
            );
          return result.changes === 1 ? now + leaseMs : undefined;
        });
      },
      release(lease) {
        return nonblocking(() => {
          return (
            db
              .prepare(
                `DELETE FROM _mirk_coordination_leases WHERE namespace=? AND key=? AND owner_token=? AND fencing_generation=? AND expires_at_ms>?`,
              )
              .run(
                namespace,
                lease.key,
                lease.ownerToken,
                lease.fencingGeneration,
                clock.now(),
              ).changes === 1
          );
        });
      },
      isOwned: owned,
    };
    super(backend, options);
    this.#db = db;
  }
  close(): void {
    this.#db.close();
  }
}
