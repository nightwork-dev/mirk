import type { InStatement, ResultSet } from "@libsql/client";
import type {
  AsyncAtomicMutationStore,
  AtomicCompletedMutationResult,
  AtomicMutationLimits,
  AtomicMutationRequest,
  AtomicMutationResult,
  StoreTarget,
  StoreVersion,
} from "@mirk/store";
import {
  AtomicMutationBackendError,
  AtomicMutationIndeterminateError,
  validateAtomicRequest,
} from "@mirk/store/atomic";
import type { LibsqlDatabase } from "./libsql-database.js";
import type { TableNames } from "./libsql-registry.js";
import {
  LibsqlVersionStorage,
  versionedRow,
  versionKey,
} from "./libsql-versions.js";
import { receiptRow } from "./libsql-receipts.js";
import { LibsqlAdapterError, guard } from "./libsql-errors.js";

export abstract class LibsqlAtomicFacet
  extends LibsqlVersionStorage
  implements AsyncAtomicMutationStore
{
  protected abstract readonly initializedTables: Map<string, string>;
  protected abstract atomicTables(
    collections: ReadonlySet<string>,
    registered: ResultSet | undefined,
  ): Promise<{ tables: Map<string, string>; ensure: InStatement[] }>;
  protected abstract registeredTablesStatement(
    collections: string[],
  ): InStatement;
  constructor(
    db: LibsqlDatabase,
    names: TableNames,
    readonly atomicLimits: AtomicMutationLimits,
    receiptRetentionMs: number | undefined,
    now: (() => number) | undefined,
  ) {
    super(db, names, receiptRetentionMs, now);
  }
  async mutateAtomically(
    request: AtomicMutationRequest,
  ): Promise<AtomicMutationResult> {
    const validated = validateAtomicRequest(request, this.atomicLimits);
    const outermost = !this.db.transactions.inTransaction();
    try {
      return await this.write(() => this.decideAtomic(validated));
    } catch (error) {
      // Inside a caller's transaction nothing has committed yet; the caller's
      // transaction reports the failure.
      if (!outermost || !(error instanceof LibsqlAdapterError)) throw error;
      if (error.code === "commit-indeterminate") {
        const key = validated.idempotency?.key;
        throw new AtomicMutationIndeterminateError(
          validated.requestDigest,
          key,
          key === undefined ? "manual-reconciliation" : "retry-with-same-key",
        );
      }
      if (
        error.code === "busy" ||
        error.code === "connection-lost" ||
        error.code === "transaction-expired"
      ) {
        throw new AtomicMutationBackendError(
          "unavailable",
          true,
          error.message,
        );
      }
      throw error;
    }
  }

  /** Decides and applies one atomic request in a fixed number of round trips,
   *  whatever its size: at most one batch reads the receipt and looks up
   *  tables, one reads every condition target, and one writes every
   *  operation, its version token and the receipt. The open write transaction
   *  holds the database's write lock throughout, so the state the conditions
   *  read is the state the writes apply to. */
  private async decideAtomic(
    validated: ReturnType<typeof validateAtomicRequest>,
  ): Promise<AtomicMutationResult> {
    const n = this.names;
    const key = validated.idempotency?.key;
    const now = key === undefined ? null : this.clock();

    const collections = new Set<string>();
    for (const { target } of validated.conditions) {
      if (target.kind === "record") collections.add(target.collection);
    }
    for (const operation of validated.operations) {
      if (operation.op === "put" || operation.op === "remove")
        collections.add(operation.collection);
    }
    const unresolved = [...collections].filter(
      (collection) => !this.initializedTables.has(collection),
    );

    // Round trip 1, when there is a receipt or a table to look up.
    const reads: InStatement[] = [];
    if (key !== undefined) reads.push(...this.pruneReceiptStatements(now));
    const receiptAt =
      key === undefined
        ? -1
        : reads.push(this.readReceiptStatement(key, now)) - 1;
    // The receipt is written in the same round trip as the version tokens it
    // records, so it needs the sequence they are issued from.
    const sequenceAt =
      key === undefined
        ? -1
        : reads.push(`SELECT value FROM ${n.sequence} WHERE id = 1`) - 1;
    const registryAt =
      unresolved.length === 0
        ? -1
        : reads.push(this.registeredTablesStatement(unresolved)) - 1;
    const first =
      reads.length === 0
        ? []
        : await this.db.inTransaction((open) => guard(open.batch(reads)));

    if (key !== undefined) {
      const prior = receiptRow(first[receiptAt]!);
      if (prior) {
        if (prior.requestDigest !== validated.requestDigest) {
          return {
            status: "idempotency-conflict",
            key,
            expectedRequestDigest: prior.requestDigest,
            receivedRequestDigest: validated.requestDigest,
          };
        }
        const result = prior.result;
        return {
          status: "replayed",
          requestDigest: result.requestDigest,
          versions: result.versions,
          ...(result.outcome === undefined ? {} : { outcome: result.outcome }),
        };
      }
    }

    const { tables, ensure } = await this.atomicTables(
      collections,
      registryAt < 0 ? undefined : first[registryAt],
    );
    const tableOf = (collection: string) => tables.get(collection)!;

    // Round trip 2, when there are conditions: every target at once.
    if (validated.conditions.length > 0) {
      const checks = [
        ...ensure.splice(0),
        ...validated.conditions.map(({ target }) =>
          this.readVersionedStatement(
            target,
            target.kind === "record" ? tableOf(target.collection) : "",
          ),
        ),
      ];
      const observed = (
        await this.db.inTransaction((open) => guard(open.batch(checks)))
      ).slice(checks.length - validated.conditions.length);
      for (const [index, condition] of validated.conditions.entries()) {
        const row = versionedRow(observed[index]!);
        const matches =
          condition.expected === "missing"
            ? row === null
            : condition.expected === "present"
              ? row !== null
              : row?.version === condition.version;
        if (matches) continue;
        let reported: StoreVersion | "missing" | "present" =
          row === null ? "missing" : "present";
        if (row !== null && condition.expected === "version") {
          // A row written before this adapter issued version tokens gets one now.
          reported =
            row.version ??
            (await this.backfillVersion(condition.target))?.version ??
            "missing";
        }
        return { status: "conflict", condition, observed: reported };
      }
    }

    // Round trip 3: every write, one sequence step for all the version tokens,
    // and the receipt. Token j of m is the sequence's new value minus m - j.
    const issuing = validated.operations.filter(
      (operation) => operation.op === "set" || operation.op === "put",
    ).length;
    const writes: InStatement[] = [...ensure];
    const sequenceAt2 =
      issuing === 0
        ? -1
        : writes.push({
            sql: `UPDATE ${n.sequence} SET value = value + CAST(? AS INTEGER) WHERE id = 1 RETURNING value`,
            args: [issuing],
          }) - 1;
    const targets: { target: StoreTarget; issued: number | null }[] = [];
    let issued = 0;
    for (const operation of validated.operations) {
      let target: StoreTarget;
      switch (operation.op) {
        case "set":
          target = { kind: "key", key: operation.key };
          writes.push(
            this.upsertKeyStatement(
              operation.key,
              JSON.stringify(operation.value),
            ),
          );
          break;
        case "delete":
          target = { kind: "key", key: operation.key };
          writes.push({
            sql: `DELETE FROM ${n.kv} WHERE key = ?`,
            args: [operation.key],
          });
          break;
        case "put":
          target = {
            kind: "record",
            collection: operation.collection,
            id: operation.item.id,
          };
          writes.push(
            this.upsertRecordStatement(
              tableOf(operation.collection),
              operation.item.id,
              JSON.stringify(operation.item),
            ),
          );
          break;
        case "remove":
          target = {
            kind: "record",
            collection: operation.collection,
            id: operation.id,
          };
          writes.push({
            sql: `DELETE FROM ${tableOf(operation.collection)} WHERE id = ?`,
            args: [operation.id],
          });
          break;
      }
      if (operation.op === "set" || operation.op === "put") {
        issued += 1;
        writes.push({
          sql: `INSERT INTO ${n.versions} (kind, collection, target_key, version)
                SELECT ?, ?, ?, ? || '-v' || (value - CAST(? AS INTEGER)) FROM ${n.sequence} WHERE id = 1
                ON CONFLICT(kind, collection, target_key) DO UPDATE SET version = excluded.version`,
          args: [...versionKey(target), this.versionPrefix, issuing - issued],
        });
        targets.push({ target, issued });
      } else {
        writes.push(this.clearVersion(target));
        targets.push({ target, issued: null });
      }
    }
    const result = (last: number): AtomicCompletedMutationResult => ({
      status: "applied",
      requestDigest: validated.requestDigest,
      versions: targets.map(({ target, issued }) => ({
        target,
        version:
          issued === null
            ? null
            : (`${this.versionPrefix}-v${last - issuing + issued}` as StoreVersion),
      })),
      ...(validated.outcome === undefined
        ? {}
        : { outcome: validated.outcome }),
    });
    const expected =
      key === undefined
        ? undefined
        : Number(first[sequenceAt]!.rows[0]!.value) + issuing;
    if (key !== undefined) {
      writes.push(
        this.writeReceiptStatement(
          key,
          validated.requestDigest,
          result(expected!),
          now,
        ),
      );
    }

    return this.db.inTransaction(async (open) => {
      const results = await guard(open.batch(writes));
      if (sequenceAt2 < 0) return result(0);
      const last = Number(results[sequenceAt2]!.rows[0]!.value);
      open.minted = Math.max(open.minted, last);
      if (expected !== undefined && last !== expected) {
        // The receipt names tokens the sequence did not issue; roll back.
        throw new Error(
          "internal: the libSQL version sequence moved during an atomic mutation",
        );
      }
      return result(last);
    });
  }
}
