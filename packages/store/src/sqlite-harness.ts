/**
 * Generic two-process SQLite evidence harness.
 *
 * This is intentionally a testing/tooling surface, not a writer service.  It
 * generates opaque records, runs independent OS processes against one database,
 * injects crashes at explicit points, and returns a path-free run receipt.
 */
import { fork } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";

import { SqliteAdapter } from "./adapters/sqlite.js";
import { namespaceStore } from "./namespace.js";
import {
  supportsAtomicMutation,
  type AtomicMutationRequest,
} from "./atomic.js";

export interface SqliteHarnessThresholds {
  /** Number of generated records in this generic run. */
  records: number;
  /** Maximum permitted p99 operation latency in milliseconds. */
  p99LatencyMs: number;
  /** Maximum permitted WAL sidecar size after the normal workload. */
  maxWalBytes: number;
  /** Maximum number of SQLITE_BUSY/SQLITE_LOCKED operation failures. */
  maxBusyErrors: number;
  /** No operation may remain unreconciled after the crash points. */
  maxIndeterminate: number;
  /** Checkpoint operations must complete within this generic bound. */
  maxCheckpointDurationMs: number;
}

/** Generic limits are deliberately not copied from a consuming application. */
export const DEFAULT_SQLITE_HARNESS_THRESHOLDS: Readonly<SqliteHarnessThresholds> =
  Object.freeze({
    records: 32,
    p99LatencyMs: 1_000,
    maxWalBytes: 8 * 1024 * 1024,
    maxBusyErrors: 0,
    maxIndeterminate: 0,
    maxCheckpointDurationMs: 1_000,
  });

export type SqliteHarnessFaultPoint =
  | "before-commit"
  | "after-commit-ack-withheld";

export interface SqliteHarnessLatencySummary {
  medianMs: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
}

export interface SqliteHarnessRecoveryResult {
  faultPoint: SqliteHarnessFaultPoint;
  killed: boolean;
  committedBeforeKill: boolean;
  reconciled: boolean;
  outcome: "not-applied" | "replayed" | "applied" | "unknown";
}

export interface SqliteHarnessMetrics {
  operationCount: number;
  applied: number;
  replayed: number;
  conflicted: number;
  failed: number;
  indeterminate: number;
  latencies: SqliteHarnessLatencySummary;
  busyWaits: number;
  busyWaitMs: number;
  sqliteBusyErrors: number;
  expectedRecords: number;
  recoveredRecords: number;
  lostRecords: number;
  namespaceIsolation: boolean;
  walPeakBytes: number;
  walFinalBytes: number;
  checkpointDurationMs: Record<"passive" | "restart" | "truncate", number>;
  checkpoints: Record<
    "passive" | "restart" | "truncate",
    {
      busy: number;
      logFrames: number;
      checkpointedFrames: number;
    }
  >;
  recovery: readonly SqliteHarnessRecoveryResult[];
}

export interface SqliteHarnessReport {
  passed: boolean;
  thresholds: SqliteHarnessThresholds;
  thresholdFailures: readonly string[];
  metrics: SqliteHarnessMetrics;
}

export interface SqliteHarnessOptions {
  /** Number of generated records per process. Defaults to the generic limit. */
  records?: number;
  /** Use a caller-owned database path; otherwise a temporary path is removed. */
  path?: string;
  /** Retain a temporary path for local debugging. Defaults to false. */
  keepArtifacts?: boolean;
  /** Override generic limits explicitly for a local run. */
  thresholds?: Partial<SqliteHarnessThresholds>;
  /** Busy timeout for both independent writer processes. */
  busyTimeoutMs?: number;
}

interface WorkerSummary {
  operationCount: number;
  applied: number;
  replayed: number;
  conflicted: number;
  failed: number;
  indeterminate: number;
  latencies: number[];
  busyWaits: number;
  busyWaitMs: number;
  sqliteBusyErrors: number;
}

interface WorkerMessage {
  type: "summary" | "ready" | "committed";
  summary?: WorkerSummary;
}

interface ForkedChild {
  on(event: string, listener: (...args: any[]) => void): ForkedChild;
  kill(signal?: NodeJS.Signals): boolean;
}

const WORKER_SOURCE = String.raw`
import { performance } from 'node:perf_hooks';
import { SqliteAdapter } from %ADAPTER% ;
import { namespaceStore } from %NAMESPACE% ;
import { supportsAtomicMutation } from %ATOMIC% ;

const options = JSON.parse(process.argv[2]);
const send = (message) => process.send?.(message);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
if (options.startDelayMs) await sleep(options.startDelayMs);
const summary = { operationCount: 0, applied: 0, replayed: 0, conflicted: 0, failed: 0,
  indeterminate: 0, latencies: [], busyWaits: 0, busyWaitMs: 0, sqliteBusyErrors: 0 };
const adapter = new SqliteAdapter({ path: options.dbPath, busyTimeoutMs: options.busyTimeoutMs });
const store = namespaceStore(adapter.kv, options.namespace);
if (!supportsAtomicMutation(store)) throw new Error('SQLite worker lacks atomic capability');
const raceStore = namespaceStore(adapter.kv, 'shared.race.v1');
if (!supportsAtomicMutation(raceStore)) throw new Error('SQLite worker lacks shared race capability');

function recordFailure(error, started) {
  summary.failed += 1;
  const code = error?.code;
  const message = String(error?.message ?? error);
  if (typeof code === 'string' && (code.startsWith('SQLITE_BUSY') || code.startsWith('SQLITE_LOCKED')) ||
      message.includes('SQLite is busy or locked') || message.includes('database is locked')) {
    summary.sqliteBusyErrors += 1;
  }
  const elapsed = performance.now() - started;
  summary.latencies.push(elapsed);
}

function mutate(request) {
  const started = performance.now();
  try {
    const result = store.mutateAtomically(request);
    const elapsed = performance.now() - started;
    summary.operationCount += 1;
    summary.latencies.push(elapsed);
    // A slow operation is a measured bounded busy wait. SQLite does not expose
    // the exact spin duration through better-sqlite3, so retain the observed
    // wall time and classify only operations above one millisecond.
    if (elapsed > 1) { summary.busyWaits += 1; summary.busyWaitMs += elapsed; }
    if (result.status === 'applied') summary.applied += 1;
    else if (result.status === 'replayed') summary.replayed += 1;
    else if (result.status === 'conflict') summary.conflicted += 1;
    return result;
  } catch (error) {
    recordFailure(error, started);
    throw error;
  }
}

if (options.mode === 'fault-before') {
  const request = { operations: [{ op: 'put', collection: 'records', item: { id: 'fault-before', value: 'rolled-back' } }],
    idempotency: { key: 'fault-before-key' } };
  // Hold an outer transaction open after the nested atomic decision. The
  // parent kills this process before the outer commit, proving that the
  // decision and its receipt do not survive a process termination before
  // commit. Atomics.wait keeps the transaction open without an async callback
  // that could accidentally return and commit.
  adapter.transaction(() => {
    mutate(request);
    const hold = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30_000);
    if (process.send) process.send({ type: 'ready' });
    hold();
  }, 'immediate');
} else if (options.mode === 'fault-after') {
  const request = { operations: [{ op: 'put', collection: 'records', item: { id: 'fault-after', value: 'committed' } }],
    idempotency: { key: 'fault-after-key' } };
  mutate(request);
  // This is a control signal, not a mutation acknowledgement. The parent kills
  // the process before it can report the mutation result or close cleanly.
  send({ type: 'committed' });
  setInterval(() => {}, 1000);
} else {
  for (let index = 0; index < options.records; index += 1) {
    const request = { operations: [{ op: 'put', collection: 'records', item: {
      id: options.namespace + ':' + options.worker + ':' + index,
      namespace: options.namespace, worker: options.worker, index, payload: 'generic-record'
    } }], idempotency: { key: 'record:' + options.namespace + ':' + options.worker + ':' + index } };
    try {
      const result = mutate(request);
      // Replay every generated request. This exercises durable receipts after
      // competing processes have written to the same physical database.
      const replay = mutate(request);
      if (replay.status !== 'replayed' && result.status === 'applied') summary.failed += 1;
    } catch {
      // mutate() records the failure; keep exercising the remaining requests.
    }
  }
  const raceRequest = { conditions: [{ target: { kind: 'key', key: 'winner' }, expected: 'missing' }],
    operations: [{ op: 'set', key: 'winner', value: options.worker }],
    idempotency: { key: 'race:' + options.worker } };
  try {
    const started = performance.now();
    const result = raceStore.mutateAtomically(raceRequest);
    const elapsed = performance.now() - started;
    summary.operationCount += 1;
    summary.latencies.push(elapsed);
    if (elapsed > 1) { summary.busyWaits += 1; summary.busyWaitMs += elapsed; }
    if (result.status === 'applied') summary.applied += 1;
    else if (result.status === 'replayed') summary.replayed += 1;
    else if (result.status === 'conflict') summary.conflicted += 1;
  } catch {
    summary.failed += 1;
  }
  send({ type: 'summary', summary });
  adapter.close();
}
`;

function quantile(values: readonly number[], percentile: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.ceil(percentile * sorted.length) - 1
  );
  return Number(sorted[index]!.toFixed(3));
}

function latencySummary(
  values: readonly number[]
): SqliteHarnessLatencySummary {
  return {
    medianMs: quantile(values, 0.5),
    p95Ms: quantile(values, 0.95),
    p99Ms: quantile(values, 0.99),
    maxMs: values.length === 0 ? 0 : Number(Math.max(...values).toFixed(3)),
  };
}

function mergeSummaries(summaries: readonly WorkerSummary[]): WorkerSummary {
  return summaries.reduce<WorkerSummary>(
    (merged, summary) => ({
      operationCount: merged.operationCount + summary.operationCount,
      applied: merged.applied + summary.applied,
      replayed: merged.replayed + summary.replayed,
      conflicted: merged.conflicted + summary.conflicted,
      failed: merged.failed + summary.failed,
      indeterminate: merged.indeterminate + summary.indeterminate,
      latencies: merged.latencies.concat(summary.latencies),
      busyWaits: merged.busyWaits + summary.busyWaits,
      busyWaitMs: merged.busyWaitMs + summary.busyWaitMs,
      sqliteBusyErrors: merged.sqliteBusyErrors + summary.sqliteBusyErrors,
    }),
    {
      operationCount: 0,
      applied: 0,
      replayed: 0,
      conflicted: 0,
      failed: 0,
      indeterminate: 0,
      latencies: [],
      busyWaits: 0,
      busyWaitMs: 0,
      sqliteBusyErrors: 0,
    }
  );
}

function runWorker(
  workerPath: string,
  options: Record<string, unknown>
): Promise<WorkerSummary> {
  return new Promise((resolveSummary, reject) => {
    const child = fork(workerPath, [JSON.stringify(options)], {
      stdio: ["ignore", "ignore", "inherit", "ipc"],
    }) as unknown as ForkedChild;
    let summary: WorkerSummary | undefined;
    child.on("message", (message: WorkerMessage) => {
      if (message.type === "summary" && message.summary)
        summary = message.summary;
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0 && summary) resolveSummary(summary);
      else
        reject(
          new Error(
            `SQLite harness worker exited ${code === null ? signal : code}.`
          )
        );
    });
  });
}

function killAt(
  workerPath: string,
  options: Record<string, unknown>,
  point: SqliteHarnessFaultPoint
): Promise<{ killed: boolean; committed: boolean }> {
  return new Promise((resolveResult, reject) => {
    const child = fork(
      workerPath,
      [
        JSON.stringify({
          ...options,
          mode: point === "before-commit" ? "fault-before" : "fault-after",
        }),
      ],
      {
        stdio: ["ignore", "ignore", "inherit", "ipc"],
      }
    ) as unknown as ForkedChild;
    let committed = false;
    let killed = false;
    child.on("message", (message: WorkerMessage) => {
      if (message.type === "ready" && point === "before-commit") {
        killed = child.kill("SIGKILL");
      } else if (
        message.type === "committed" &&
        point === "after-commit-ack-withheld"
      ) {
        committed = true;
        killed = child.kill("SIGKILL");
      }
    });
    child.on("error", reject);
    child.on("exit", () => {
      if (killed) resolveResult({ killed, committed });
      else
        reject(
          new Error(`SQLite harness fault worker did not reach ${point}.`)
        );
    });
  });
}

function checkpoint(
  adapter: SqliteAdapter,
  mode: "passive" | "restart" | "truncate"
) {
  const started = performance.now();
  const result = adapter.checkpoint(mode);
  return {
    result,
    durationMs: Number((performance.now() - started).toFixed(3)),
  };
}

/** Execute the repository-owned generic direct-SQLite evidence run. */
export async function runSqliteConcurrencyHarness(
  options: SqliteHarnessOptions = {}
): Promise<SqliteHarnessReport> {
  const thresholds: SqliteHarnessThresholds = {
    ...DEFAULT_SQLITE_HARNESS_THRESHOLDS,
    ...options.thresholds,
  };
  const records = options.records ?? thresholds.records;
  if (!Number.isSafeInteger(records) || records <= 0)
    throw new Error("records must be a positive safe integer");
  if (thresholds.records !== records) thresholds.records = records;

  const root = join(
    tmpdir(),
    `mirk-sqlite-harness-${process.pid}-${Date.now()}-${Math.random()
      .toString(16)
      .slice(2)}`
  );
  const dbPath = options.path ?? join(root, "harness.sqlite");
  mkdirSync(root, { recursive: true });
  const workerPath = join(root, "worker.mjs");
  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const adapterEntry = pathToFileURL(
    resolve(packageRoot, "dist/adapters/sqlite.js")
  ).href;
  const namespaceEntry = pathToFileURL(
    resolve(packageRoot, "dist/index.js")
  ).href;
  const atomicEntry = pathToFileURL(
    resolve(packageRoot, "dist/atomic.js")
  ).href;
  writeFileSync(
    workerPath,
    WORKER_SOURCE.replace("%ADAPTER%", JSON.stringify(adapterEntry))
      .replace("%NAMESPACE%", JSON.stringify(namespaceEntry))
      .replace("%ATOMIC%", JSON.stringify(atomicEntry)),
    "utf8"
  );

  // Schema/bootstrap pragmas also contend when both OS processes start at
  // once. Keep this bounded but long enough to avoid classifying startup as a
  // workload failure on slower CI filesystems.
  const busyTimeoutMs = options.busyTimeoutMs ?? 5_000;
  const recovery: SqliteHarnessRecoveryResult[] = [];
  try {
    const summaries = await Promise.all([
      runWorker(workerPath, {
        dbPath,
        records,
        worker: "left",
        namespace: "namespace.left.v1",
        busyTimeoutMs,
      }),
      runWorker(workerPath, {
        dbPath,
        records,
        worker: "right",
        namespace: "namespace.right.v1",
        busyTimeoutMs,
        startDelayMs: 250,
      }),
    ]);
    const merged = mergeSummaries(summaries);
    const adapter = new SqliteAdapter({ path: dbPath, busyTimeoutMs });
    let adapterClosed = false;
    try {
      // Parent-side reconciliation starts from a fresh connection. This checks
      // that receipt and version state survived independent process close.
      const beforeFault = adapter.inspect();
      const beforeBytes = beforeFault.walFileSizeBytes ?? 0;
      const before = await killAt(
        workerPath,
        { dbPath, records, worker: "fault", namespace: "fault", busyTimeoutMs },
        "before-commit"
      );
      const beforeReplayStore = namespaceStore(adapter.kv, "fault");
      if (!supportsAtomicMutation(beforeReplayStore))
        throw new Error(
          "SQLite harness pre-commit reconciliation lacks atomic capability"
        );
      const beforeReplay = beforeReplayStore.mutateAtomically({
        operations: [
          {
            op: "put",
            collection: "records",
            item: { id: "fault-before", value: "rolled-back" },
          },
        ],
        idempotency: { key: "fault-before-key" },
      });
      recovery.push({
        faultPoint: "before-commit",
        killed: before.killed,
        committedBeforeKill: before.committed,
        reconciled: beforeReplay.status === "applied",
        outcome: beforeReplay.status === "applied" ? "not-applied" : "unknown",
      });
      const after = await killAt(
        workerPath,
        { dbPath, records, worker: "fault", namespace: "fault", busyTimeoutMs },
        "after-commit-ack-withheld"
      );
      const replayStore = namespaceStore(adapter.kv, "fault");
      if (!supportsAtomicMutation(replayStore))
        throw new Error(
          "SQLite harness reconciliation lacks atomic capability"
        );
      const replayRequest: AtomicMutationRequest = {
        operations: [
          {
            op: "put",
            collection: "records",
            item: { id: "fault-after", value: "committed" },
          },
        ],
        idempotency: { key: "fault-after-key" },
      };
      const replay = replayStore.mutateAtomically(replayRequest);
      const reconciled =
        replay.status === "replayed" || replay.status === "applied";
      recovery.push({
        faultPoint: "after-commit-ack-withheld",
        killed: after.killed,
        committedBeforeKill: after.committed,
        reconciled,
        outcome:
          replay.status === "replayed"
            ? "replayed"
            : replay.status === "applied"
            ? "applied"
            : "unknown",
      });

      // Reopen with a separate adapter before checking record counts and WAL
      // behavior. A stale in-process handle must not mask recovery failures.
      adapter.close();
      adapterClosed = true;
      const reopened = new SqliteAdapter({ path: dbPath, busyTimeoutMs });
      const left = namespaceStore(reopened.kv, "namespace.left.v1");
      const right = namespaceStore(reopened.kv, "namespace.right.v1");
      const expectedRecords = records * 2;
      const leftRecords = left.list<{ id: string; namespace: string }>(
        "records"
      );
      const rightRecords = right.list<{ id: string; namespace: string }>(
        "records"
      );
      const recoveredRecords = leftRecords.length + rightRecords.length;
      const namespaceIsolation =
        leftRecords.every(
          (record) => record.namespace === "namespace.left.v1"
        ) &&
        rightRecords.every(
          (record) => record.namespace === "namespace.right.v1"
        );
      const preCheckpoint = reopened.inspect();
      const passive = checkpoint(reopened, "passive");
      const restart = checkpoint(reopened, "restart");
      const truncate = checkpoint(reopened, "truncate");
      const finalInspection = reopened.inspect();
      const finalBytes = finalInspection.walFileSizeBytes ?? 0;
      reopened.close();
      const checkpointDurationMs = {
        passive: passive.durationMs,
        restart: restart.durationMs,
        truncate: truncate.durationMs,
      } as const;
      const checkpointResults = {
        passive: passive.result,
        restart: restart.result,
        truncate: truncate.result,
      } as const;
      const metrics: SqliteHarnessMetrics = {
        operationCount: merged.operationCount,
        applied: merged.applied,
        replayed: merged.replayed,
        conflicted: merged.conflicted,
        failed: merged.failed,
        indeterminate: merged.indeterminate,
        latencies: latencySummary(merged.latencies),
        busyWaits: merged.busyWaits,
        busyWaitMs: Number(merged.busyWaitMs.toFixed(3)),
        sqliteBusyErrors: merged.sqliteBusyErrors,
        expectedRecords,
        recoveredRecords,
        lostRecords: expectedRecords - recoveredRecords,
        namespaceIsolation,
        walPeakBytes: Math.max(
          beforeBytes,
          preCheckpoint.walFileSizeBytes ?? 0,
          finalBytes
        ),
        walFinalBytes: finalBytes,
        checkpointDurationMs,
        checkpoints: checkpointResults,
        recovery,
      };
      const thresholdFailures: string[] = [];
      if (metrics.latencies.p99Ms > thresholds.p99LatencyMs)
        thresholdFailures.push("p99 latency exceeded threshold");
      if (metrics.walPeakBytes > thresholds.maxWalBytes)
        thresholdFailures.push("WAL size exceeded threshold");
      if (metrics.sqliteBusyErrors > thresholds.maxBusyErrors)
        thresholdFailures.push("unclassified SQLite busy errors observed");
      if (metrics.indeterminate > thresholds.maxIndeterminate)
        thresholdFailures.push("indeterminate outcomes remained unreconciled");
      if (metrics.lostRecords !== 0)
        thresholdFailures.push("silent record loss observed");
      if (!metrics.namespaceIsolation)
        thresholdFailures.push("namespace isolation failed");
      if (
        Object.values(metrics.checkpointDurationMs).some(
          (duration) => duration > thresholds.maxCheckpointDurationMs
        )
      )
        thresholdFailures.push("checkpoint duration exceeded threshold");
      if (recovery.some((entry) => !entry.killed || !entry.reconciled))
        thresholdFailures.push("fault recovery was incomplete");
      return {
        passed: thresholdFailures.length === 0,
        thresholds,
        thresholdFailures,
        metrics,
      };
    } finally {
      // `adapter` is closed above before reopen; close is idempotent only at the
      // better-sqlite3 level, so avoid calling it again after that branch.
      try {
        if (!adapterClosed) adapter.close();
      } catch {}
    }
  } finally {
    if (!options.keepArtifacts) {
      rmSync(root, { recursive: true, force: true });
    }
  }
}
