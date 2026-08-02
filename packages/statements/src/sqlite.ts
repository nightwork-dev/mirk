import { createHash, randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import {
  createSqliteCoordinator,
  type AsyncCoordinator,
} from "@mirk/store/coordination";

import {
  STATEMENTS_STORAGE_SCHEMA_VERSION,
  type StatementAdmissionAuthority,
  type StatementAdmissionRequest,
  type StatementAdmissionEnvelope,
  type StatementRevisionEnvelope,
  type StatementRetractionEnvelope,
  type StatementRecord,
  type StatementRef,
  type StatementReceipt,
  type StatementOperationResult,
  type StatementReceiptCode,
  type StatementStatus,
  type StatementLensQuery,
  type TemporalInterval,
  type StatementModality,
  type StatementBackfillState,
} from "./types.js";

export interface SqliteStatementStoreOptions {
  readonly path: string;
  readonly db?: Database.Database;
  readonly coordinator?: AsyncCoordinator;
  readonly authority: StatementAdmissionAuthority;
  readonly busyTimeoutMs?: number;
  readonly now?: () => Date;
  readonly receiptIdFactory?: () => string;
}

interface RevisionRow {
  world_id: string;
  branch_id: string;
  statement_id: string;
  revision: number;
  status: StatementStatus;
  modality: StatementModality;
  polarity: string;
  context_kind: string;
  actor_instance_id: string | null;
  recorded_at: string;
  valid_from_key: string;
  valid_to_key: string;
  source_ids_json: string;
  body_json: string;
}

interface ReceiptRow {
  result_json: string;
  fingerprint: string;
}

export function createSqliteStatementStore(
  options: SqliteStatementStoreOptions
): SqliteStatementStore {
  return new SqliteStatementStore(options);
}

export class SqliteStatementStore {
  readonly #db: Database.Database;
  readonly #coordinator: AsyncCoordinator;
  readonly #authority: StatementAdmissionAuthority;
  readonly #ownsDb: boolean;
  readonly #now: () => Date;
  readonly #receiptIdFactory: () => string;

  constructor(options: SqliteStatementStoreOptions) {
    if (!options.path)
      throw new Error("SqliteStatementStore requires a database path.");
    this.#ownsDb = options.db === undefined;
    this.#db =
      options.db ??
      new Database(options.path, { timeout: options.busyTimeoutMs ?? 30_000 });
    this.#coordinator =
      options.coordinator ??
      createSqliteCoordinator({
        path: options.path,
        namespace: "mirk-statements",
        busyTimeoutMs: options.busyTimeoutMs,
      });
    this.#authority = options.authority;
    this.#now = options.now ?? (() => new Date());
    this.#receiptIdFactory =
      options.receiptIdFactory ?? (() => `receipt:${randomUUID()}`);
    this.migrate();
  }

  migrate(): void {
    this.#db.pragma("foreign_keys = ON");
    this.#db.pragma("journal_mode = WAL");
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS _mirk_statements_migrations (
        version TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS mirk_statement_revisions (
        world_id TEXT NOT NULL,
        branch_id TEXT NOT NULL,
        statement_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        status TEXT NOT NULL,
        modality TEXT NOT NULL,
        polarity TEXT NOT NULL,
        context_kind TEXT NOT NULL,
        actor_instance_id TEXT,
        recorded_at TEXT NOT NULL,
        valid_from_key TEXT NOT NULL,
        valid_to_key TEXT NOT NULL,
        source_ids_json TEXT NOT NULL,
        receipt_id TEXT NOT NULL,
        body_json TEXT NOT NULL,
        PRIMARY KEY (world_id, branch_id, statement_id, revision)
      );

      CREATE TABLE IF NOT EXISTS mirk_statement_heads (
        world_id TEXT NOT NULL,
        branch_id TEXT NOT NULL,
        statement_id TEXT NOT NULL,
        head_revision INTEGER NOT NULL,
        terminal_status TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (world_id, branch_id, statement_id)
      );

      CREATE TABLE IF NOT EXISTS mirk_statement_receipts (
        authority_scope TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        operation_kind TEXT NOT NULL,
        statement_key TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        result_json TEXT NOT NULL,
        committed_at TEXT NOT NULL,
        PRIMARY KEY (authority_scope, idempotency_key, operation_kind)
      );

      CREATE TABLE IF NOT EXISTS mirk_statement_backfills (
        backfill_id TEXT PRIMARY KEY,
        source_name TEXT NOT NULL,
        cursor_json TEXT,
        status TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_mirk_statement_heads_branch
        ON mirk_statement_heads (world_id, branch_id, updated_at);
      CREATE INDEX IF NOT EXISTS idx_mirk_statement_revisions_lens
        ON mirk_statement_revisions (world_id, branch_id, status, context_kind, recorded_at);
      CREATE INDEX IF NOT EXISTS idx_mirk_statement_revisions_actor
        ON mirk_statement_revisions (world_id, branch_id, actor_instance_id, status, recorded_at);
      CREATE INDEX IF NOT EXISTS idx_mirk_statement_revisions_time
        ON mirk_statement_revisions (world_id, branch_id, valid_from_key, valid_to_key, recorded_at);
      CREATE INDEX IF NOT EXISTS idx_mirk_statement_revisions_provenance
        ON mirk_statement_revisions (world_id, branch_id, source_ids_json);
    `);
    this.#db
      .prepare(
        `INSERT OR IGNORE INTO _mirk_statements_migrations (version, applied_at) VALUES (?, ?)`
      )
      .run(STATEMENTS_STORAGE_SCHEMA_VERSION, this.#now().toISOString());
  }

  async admit(
    envelope: StatementAdmissionEnvelope
  ): Promise<StatementOperationResult> {
    return this.#run({ operationKind: "admit", envelope });
  }

  async revise(
    envelope: StatementRevisionEnvelope
  ): Promise<StatementOperationResult> {
    return this.#run({ operationKind: "revise", envelope });
  }

  async retract(
    envelope: StatementRetractionEnvelope
  ): Promise<StatementOperationResult> {
    return this.#run({ operationKind: "retract", envelope });
  }

  getHead(ref: StatementRef): StatementRecord | null {
    const head = this.#db
      .prepare(
        `SELECT head_revision FROM mirk_statement_heads
         WHERE world_id = ? AND branch_id = ? AND statement_id = ?`
      )
      .get(ref.worldId, ref.branchId, ref.statementId) as
      | { head_revision: number }
      | undefined;
    if (!head) return null;
    return this.getRevision(ref, head.head_revision);
  }

  getRevision(ref: StatementRef, revision: number): StatementRecord | null {
    const row = this.#db
      .prepare(
        `SELECT * FROM mirk_statement_revisions
         WHERE world_id = ? AND branch_id = ? AND statement_id = ? AND revision = ?`
      )
      .get(ref.worldId, ref.branchId, ref.statementId, revision) as
      | RevisionRow
      | undefined;
    return row ? recordFromRow(row) : null;
  }

  listHistory(ref: StatementRef): StatementRecord[] {
    return (
      this.#db
        .prepare(
          `SELECT * FROM mirk_statement_revisions
           WHERE world_id = ? AND branch_id = ? AND statement_id = ?
           ORDER BY revision ASC`
        )
        .all(ref.worldId, ref.branchId, ref.statementId) as RevisionRow[]
    ).map(recordFromRow);
  }

  query(query: StatementLensQuery): StatementRecord[] {
    const params: unknown[] = [query.worldId, query.branchId];
    const where = [
      "r.world_id = ?",
      "r.branch_id = ?",
      "r.revision = h.head_revision",
    ];
    if (query.contextKind) {
      where.push("r.context_kind = ?");
      params.push(query.contextKind);
    }
    if (query.actorInstanceId) {
      where.push("r.actor_instance_id = ?");
      params.push(query.actorInstanceId);
    }
    appendIn(where, params, "r.status", query.statuses);
    appendIn(where, params, "r.modality", query.modalities);
    if (query.validAt) {
      where.push("r.valid_from_key <= ?", "r.valid_to_key >= ?");
      params.push(`instant:${query.validAt}`, `instant:${query.validAt}`);
    }
    if (query.recordedFrom) {
      where.push("r.recorded_at >= ?");
      params.push(query.recordedFrom);
    }
    if (query.recordedTo) {
      where.push("r.recorded_at <= ?");
      params.push(query.recordedTo);
    }
    const limit = Math.max(0, Math.floor(query.limit ?? 100));
    const rows = this.#db
      .prepare(
        `SELECT r.* FROM mirk_statement_revisions r
         JOIN mirk_statement_heads h
           ON h.world_id = r.world_id
          AND h.branch_id = r.branch_id
          AND h.statement_id = r.statement_id
         WHERE ${where.join(" AND ")}
         ORDER BY r.recorded_at DESC, r.statement_id ASC
         LIMIT ${limit}`
      )
      .all(...params) as RevisionRow[];
    const records = rows.map(recordFromRow);
    if (!query.sourceIds?.length) return records;
    const sourceSet = new Set(query.sourceIds);
    return records.filter((record) =>
      record.provenance.sources.some((source) => sourceSet.has(source.sourceId))
    );
  }

  beginBackfill(
    backfillId: string,
    sourceName: string,
    cursor?: unknown
  ): StatementBackfillState {
    return this.#writeBackfill(backfillId, sourceName, "running", cursor);
  }

  updateBackfill(
    backfillId: string,
    sourceName: string,
    status: StatementBackfillState["status"],
    cursor?: unknown
  ): StatementBackfillState {
    return this.#writeBackfill(backfillId, sourceName, status, cursor);
  }

  getBackfill(backfillId: string): StatementBackfillState | null {
    const row = this.#db
      .prepare(
        `SELECT backfill_id, source_name, cursor_json, status, updated_at
         FROM mirk_statement_backfills
         WHERE backfill_id = ?`
      )
      .get(backfillId) as
      | {
          backfill_id: string;
          source_name: string;
          cursor_json: string | null;
          status: StatementBackfillState["status"];
          updated_at: string;
        }
      | undefined;
    if (!row) return null;
    return {
      backfillId: row.backfill_id,
      sourceName: row.source_name,
      cursor:
        row.cursor_json === null ? undefined : JSON.parse(row.cursor_json),
      status: row.status,
      updatedAt: row.updated_at,
    };
  }

  close(): void {
    if (this.#ownsDb) this.#db.close();
  }

  async #run(
    request: StatementAdmissionRequest
  ): Promise<StatementOperationResult> {
    validateRequest(request);
    const key = `statement:${request.envelope.worldId}:${request.envelope.branchId}:${request.envelope.statementId}`;
    return this.#coordinator.runExclusive(key, async (guard) => {
      guard.assertOwned();
      return this.#db.transaction(() => {
        const fingerprint = fingerprintFor(request);
        const existing = this.#existingReceipt(request);
        if (existing) {
          const parsed = JSON.parse(
            existing.result_json
          ) as StatementOperationResult;
          if (existing.fingerprint === fingerprint)
            return { ...parsed, replay: true };
          return this.#persistRefusal(
            request,
            "idempotency-conflict",
            "store",
            "idempotency-conflict",
            fingerprint,
            false
          );
        }
        const decision = this.#authority.decide(request.envelope.auth, request);
        if (decision.outcome.kind === "refuse") {
          return this.#persistRefusal(
            request,
            "authority-refused",
            "authority",
            decision.outcome.code,
            fingerprint
          );
        }
        return this.#commitMutation(
          request,
          decision.outcome.status,
          fingerprint
        );
      })();
    });
  }

  #commitMutation(
    request: StatementAdmissionRequest,
    decidedStatus: StatementStatus,
    fingerprint: string
  ): StatementOperationResult {
    const ref = statementRefFor(request);
    const head = this.getHead(ref);
    if (head && isTerminal(head.status)) {
      return this.#persistRefusal(
        request,
        "revision-conflict",
        "store",
        "terminal-head",
        fingerprint
      );
    }
    if (request.operationKind === "admit") {
      if (head)
        return this.#persistRefusal(
          request,
          "revision-conflict",
          "store",
          "head-exists",
          fingerprint
        );
      const status = initialStatus(
        enforceStoreStatus(request.envelope.provenance, decidedStatus)
      );
      const record: StatementRecord = {
        statementId: request.envelope.statementId,
        revision: 1,
        proposition: request.envelope.proposition,
        context: request.envelope.context,
        modality: request.envelope.modality,
        polarity: request.envelope.polarity,
        validTime: request.envelope.validTime,
        recordedTime: { kind: "instant", at: request.envelope.recordedAt },
        status,
        qualifiers: request.envelope.qualifiers ?? {},
        provenance: request.envelope.provenance,
        derivedFrom: request.envelope.derivedFrom ?? [],
        confidence: request.envelope.confidence,
        admissionReceiptId: this.#receiptIdFactory(),
      };
      return this.#persistCommit(request, record, undefined, fingerprint);
    }
    if (!head)
      return this.#persistRefusal(
        request,
        "revision-conflict",
        "store",
        "missing-head",
        fingerprint
      );
    if (head.revision !== request.envelope.expectedRevision) {
      return this.#persistRefusal(
        request,
        "revision-conflict",
        "store",
        "expected-revision-mismatch",
        fingerprint
      );
    }
    if (request.operationKind === "retract") {
      const record: StatementRecord = {
        ...head,
        revision: head.revision + 1,
        recordedTime: { kind: "instant", at: request.envelope.recordedAt },
        status: "retracted",
        provenance: request.envelope.provenance,
        admissionReceiptId: this.#receiptIdFactory(),
      };
      return this.#persistCommit(request, record, head.revision, fingerprint);
    }
    const status = transitionStatus(
      head.status,
      enforceStoreStatus(
        request.envelope.patch.provenance ?? head.provenance,
        request.envelope.patch.status ?? decidedStatus
      )
    );
    const supersededBy =
      request.envelope.patch.supersededBy ?? head.supersededBy;
    if (status === "superseded" && !supersededBy) {
      return this.#persistRefusal(
        request,
        "store-refused",
        "store",
        "superseded-requires-reference",
        fingerprint
      );
    }
    const record: StatementRecord = {
      ...head,
      ...request.envelope.patch,
      supersededBy,
      revision: head.revision + 1,
      recordedTime: { kind: "instant", at: request.envelope.recordedAt },
      status,
      admissionReceiptId: this.#receiptIdFactory(),
    };
    return this.#persistCommit(request, record, head.revision, fingerprint);
  }

  #persistCommit(
    request: StatementAdmissionRequest,
    record: StatementRecord,
    fromRevision: number | undefined,
    fingerprint: string
  ): StatementOperationResult {
    validateRecord(record);
    const receipt: StatementReceipt = {
      receiptId: record.admissionReceiptId,
      operationKind: request.operationKind,
      authorityScope: request.envelope.auth.authorityScope,
      idempotencyKey: request.envelope.idempotencyKey,
      statement: statementRefFor(request),
      code: "committed",
      committedAt: request.envelope.recordedAt,
      affected: [
        {
          statement: statementRefFor(request),
          fromRevision,
          toRevision: record.revision,
          status: record.status,
        },
      ],
      fingerprint,
      metadata: {
        schemaVersion: STATEMENTS_STORAGE_SCHEMA_VERSION,
        authorityId: this.#authority.authorityId,
        authorityRevision: this.#authority.authorityRevision,
        ...(request.envelope.receiptMetadata ?? {}),
      },
    };
    this.#insertRevision(record);
    this.#db
      .prepare(
        `INSERT INTO mirk_statement_heads
          (world_id, branch_id, statement_id, head_revision, terminal_status, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(world_id, branch_id, statement_id)
         DO UPDATE SET head_revision = excluded.head_revision,
           terminal_status = excluded.terminal_status,
           updated_at = excluded.updated_at`
      )
      .run(
        record.context.worldId,
        record.context.branchId,
        record.statementId,
        record.revision,
        isTerminal(record.status) ? record.status : null,
        request.envelope.recordedAt
      );
    const result: StatementOperationResult = {
      ok: true,
      replay: false,
      statement: record,
      receipt,
    };
    this.#persistReceipt(request, fingerprint, result);
    return result;
  }

  #persistRefusal(
    request: StatementAdmissionRequest,
    code: Exclude<StatementReceiptCode, "committed">,
    refusedBy: "authority" | "store",
    reason: string,
    fingerprint: string,
    persist = true
  ): StatementOperationResult {
    const receipt: StatementReceipt = {
      receiptId: this.#receiptIdFactory(),
      operationKind: request.operationKind,
      authorityScope: request.envelope.auth.authorityScope,
      idempotencyKey: request.envelope.idempotencyKey,
      statement: statementRefFor(request),
      code,
      committedAt: request.envelope.recordedAt,
      affected: [],
      refusedBy,
      reason,
      fingerprint,
      metadata: {
        schemaVersion: STATEMENTS_STORAGE_SCHEMA_VERSION,
        authorityId: this.#authority.authorityId,
        authorityRevision: this.#authority.authorityRevision,
        ...(request.envelope.receiptMetadata ?? {}),
      },
    };
    const result: StatementOperationResult = {
      ok: false,
      replay: false,
      code,
      receipt,
    };
    if (persist) this.#persistReceipt(request, fingerprint, result);
    return result;
  }

  #insertRevision(record: StatementRecord): void {
    const validKeys = validTimeKeys(record.validTime);
    this.#db
      .prepare(
        `INSERT INTO mirk_statement_revisions
          (world_id, branch_id, statement_id, revision, status, modality, polarity,
           context_kind, actor_instance_id, recorded_at, valid_from_key, valid_to_key,
           source_ids_json, receipt_id, body_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        record.context.worldId,
        record.context.branchId,
        record.statementId,
        record.revision,
        record.status,
        record.modality,
        record.polarity,
        record.context.kind,
        record.context.actorInstanceId ?? null,
        record.recordedTime.at,
        validKeys.from,
        validKeys.to,
        JSON.stringify(
          record.provenance.sources.map((source) => source.sourceId).sort()
        ),
        record.admissionReceiptId,
        JSON.stringify(record)
      );
  }

  #existingReceipt(request: StatementAdmissionRequest): ReceiptRow | undefined {
    return this.#db
      .prepare(
        `SELECT result_json, fingerprint FROM mirk_statement_receipts
         WHERE authority_scope = ? AND idempotency_key = ? AND operation_kind = ?`
      )
      .get(
        request.envelope.auth.authorityScope,
        request.envelope.idempotencyKey,
        request.operationKind
      ) as ReceiptRow | undefined;
  }

  #persistReceipt(
    request: StatementAdmissionRequest,
    fingerprint: string,
    result: StatementOperationResult
  ): void {
    this.#db
      .prepare(
        `INSERT INTO mirk_statement_receipts
          (authority_scope, idempotency_key, operation_kind, statement_key, fingerprint, result_json, committed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        request.envelope.auth.authorityScope,
        request.envelope.idempotencyKey,
        request.operationKind,
        `${request.envelope.worldId}:${request.envelope.branchId}:${request.envelope.statementId}`,
        fingerprint,
        JSON.stringify(result),
        request.envelope.recordedAt
      );
  }

  #writeBackfill(
    backfillId: string,
    sourceName: string,
    status: StatementBackfillState["status"],
    cursor?: unknown
  ): StatementBackfillState {
    if (!backfillId) throw new Error("backfillId is required.");
    if (!sourceName) throw new Error("sourceName is required.");
    const updatedAt = this.#now().toISOString();
    this.#db
      .prepare(
        `INSERT INTO mirk_statement_backfills
          (backfill_id, source_name, cursor_json, status, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(backfill_id)
         DO UPDATE SET source_name = excluded.source_name,
           cursor_json = excluded.cursor_json,
           status = excluded.status,
           updated_at = excluded.updated_at`
      )
      .run(
        backfillId,
        sourceName,
        cursor === undefined ? null : JSON.stringify(cursor),
        status,
        updatedAt
      );
    return { backfillId, sourceName, cursor, status, updatedAt };
  }
}

function appendIn(
  where: string[],
  params: unknown[],
  field: string,
  values?: readonly string[]
): void {
  if (!values?.length) return;
  where.push(`${field} IN (${values.map(() => "?").join(", ")})`);
  params.push(...values);
}

function recordFromRow(row: RevisionRow): StatementRecord {
  return JSON.parse(row.body_json) as StatementRecord;
}

function statementRefFor(request: StatementAdmissionRequest): StatementRef {
  return {
    statementId: request.envelope.statementId,
    worldId: request.envelope.worldId,
    branchId: request.envelope.branchId,
  };
}

function fingerprintFor(request: StatementAdmissionRequest): string {
  return createHash("sha256").update(stableStringify(request)).digest("hex");
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, val]) => `${JSON.stringify(key)}:${stableStringify(val)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function isTerminal(status: StatementStatus): boolean {
  return (
    status === "rejected" || status === "superseded" || status === "retracted"
  );
}

function initialStatus(status: StatementStatus): StatementStatus {
  if (isTerminal(status))
    throw new Error(
      "Initial admission may not create a terminal statement head."
    );
  return status;
}

function transitionStatus(
  from: StatementStatus,
  to: StatementStatus
): StatementStatus {
  if (from === "proposed") return to;
  if (from === "accepted" && (to === "accepted" || to === "superseded"))
    return to;
  throw new Error(`Invalid statement status transition ${from} -> ${to}.`);
}

function enforceStoreStatus(
  provenance: { origin: { source: string; modelInvolved: boolean } },
  status: StatementStatus
): StatementStatus {
  if (
    provenance.origin.modelInvolved ||
    provenance.origin.source === "inferred" ||
    provenance.origin.source === "perceived" ||
    provenance.origin.source === "consolidated"
  ) {
    return "proposed";
  }
  return status;
}

function validTimeKeys(validTime?: TemporalInterval): {
  from: string;
  to: string;
} {
  return {
    from: boundKey(validTime?.from, "0000-00-00T00:00:00.000Z"),
    to: boundKey(validTime?.to, "9999-99-99T99:99:99.999Z"),
  };
}

function boundKey(
  bound: TemporalInterval["from"] | undefined,
  fallback: string
): string {
  if (!bound || bound.kind === "unbounded" || bound.kind === "unknown")
    return `instant:${fallback}`;
  if (bound.kind === "instant") return `instant:${bound.at}`;
  if (bound.kind === "before") return `before:${bound.anchor.anchorId}`;
  return `after:${bound.anchor.anchorId}`;
}

function validateRequest(request: StatementAdmissionRequest): void {
  const envelope = request.envelope;
  for (const [name, value] of Object.entries({
    principalId: envelope.auth.principalId,
    authorityScope: envelope.auth.authorityScope,
    callerPolicy: envelope.auth.callerPolicy,
    idempotencyKey: envelope.idempotencyKey,
    worldId: envelope.worldId,
    branchId: envelope.branchId,
    statementId: envelope.statementId,
    recordedAt: envelope.recordedAt,
  })) {
    if (typeof value !== "string" || value.length === 0)
      throw new Error(`${name} is required.`);
  }
  if (request.operationKind === "admit") {
    if (request.envelope.context.worldId !== request.envelope.worldId)
      throw new Error("context.worldId must match envelope.worldId.");
    if (request.envelope.context.branchId !== request.envelope.branchId)
      throw new Error("context.branchId must match envelope.branchId.");
  }
  if (request.operationKind === "revise" && request.envelope.patch.context) {
    if (request.envelope.patch.context.worldId !== request.envelope.worldId)
      throw new Error("patch.context.worldId must match envelope.worldId.");
    if (request.envelope.patch.context.branchId !== request.envelope.branchId)
      throw new Error("patch.context.branchId must match envelope.branchId.");
  }
}

function validateRecord(record: StatementRecord): void {
  if (
    record.context.kind === "actor-epistemic" &&
    !record.context.actorInstanceId
  ) {
    throw new Error("actor-epistemic context requires actorInstanceId.");
  }
  if (
    record.context.kind !== "actor-epistemic" &&
    record.context.actorInstanceId
  ) {
    throw new Error(
      "actorInstanceId is only allowed for actor-epistemic context."
    );
  }
  if (!record.provenance.sources.length)
    throw new Error("statement provenance requires at least one source.");
  if (!record.admissionReceiptId)
    throw new Error("statement revision requires admissionReceiptId.");
}
