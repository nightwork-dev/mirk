import { beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_SQLITE_HARNESS_THRESHOLDS,
  runSqliteConcurrencyHarness,
} from "./sqlite-harness.js";

describe("generic two-process SQLite evidence harness", () => {
  beforeAll(() => {
    execFileSync("pnpm", ["--filter", "@mirk/store", "build"], {
      cwd: resolve(dirname(fileURLToPath(import.meta.url)), "../.."),
      stdio: "inherit",
    });
  }, 60_000);

  it("passes contention, fault recovery, reopen, and checkpoint gates with generated records", async () => {
    const report = await runSqliteConcurrencyHarness({ records: 12 });
    expect(report.thresholds.p99LatencyMs).toBe(
      DEFAULT_SQLITE_HARNESS_THRESHOLDS.p99LatencyMs
    );
    expect(report.metrics.expectedRecords).toBe(24);
    expect(report.metrics.recoveredRecords).toBe(24);
    expect(report.metrics.lostRecords).toBe(0);
    expect(report.metrics.namespaceIsolation).toBe(true);
    expect(report.metrics.conflicted).toBeGreaterThanOrEqual(1);
    expect(report.metrics.replayed).toBeGreaterThanOrEqual(24);
    expect(report.metrics.recovery).toEqual([
      expect.objectContaining({
        faultPoint: "before-commit",
        killed: true,
        outcome: "not-applied",
      }),
      expect.objectContaining({
        faultPoint: "after-commit-ack-withheld",
        killed: true,
        reconciled: true,
        outcome: "replayed",
      }),
    ]);
    expect(report.thresholdFailures).toEqual([]);
    expect(report.passed).toBe(true);
    expect(report.metrics.latencies.p95Ms).toBeGreaterThanOrEqual(0);
    expect(report.metrics.checkpoints.truncate.busy).toBeGreaterThanOrEqual(0);
  }, 90_000);
});
