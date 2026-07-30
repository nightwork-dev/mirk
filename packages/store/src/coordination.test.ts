import { execFileSync, fork } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import Database from "better-sqlite3";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  CoordinationAbortedError,
  CoordinationOwnershipLostError,
  SqliteCoordinator,
  type CoordinationGuard,
} from "./coordination.js";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, "..");
const repoRoot = resolve(packageRoot, "../..");
const delay = (ms: number) =>
  new Promise((resolveDelay) => setTimeout(resolveDelay, ms));

let tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
  tempRoots = [];
});

function tempPath(name: string): string {
  const root = join(
    tmpdir(),
    `mirk-coordination-${process.pid}-${Date.now()}-${Math.random()
      .toString(16)
      .slice(2)}`
  );
  mkdirSync(root, { recursive: true });
  tempRoots.push(root);
  return join(root, name);
}

function openCoordinator(path: string, namespace = "test"): SqliteCoordinator {
  return new SqliteCoordinator({ path, namespace, busyTimeoutMs: 100 });
}

describe("SqliteCoordinator", () => {
  it("acquires a key, exposes a fencing generation, and releases the lease", async () => {
    const path = tempPath("coordination.sqlite");
    const coordinator = openCoordinator(path);
    let generation = 0;

    await coordinator.runExclusive("story:1", async (guard) => {
      generation = guard.fencingGeneration;
      guard.assertOwned();
    });
    coordinator.close();

    expect(generation).toBe(1);
    const db = new Database(path);
    expect(
      db
        .prepare("SELECT count(*) AS count FROM _mirk_coordination_leases")
        .get()
    ).toEqual({ count: 0 });
    db.close();
  });

  it("queues a second same-process owner until the first owner releases", async () => {
    const path = tempPath("coordination.sqlite");
    const coordinator = openCoordinator(path);
    let releaseFirst!: () => void;
    let secondEntered = false;

    const first = coordinator.runExclusive("story:1", async () => {
      await new Promise<void>((resolveRelease) => {
        releaseFirst = resolveRelease;
      });
    });
    await delay(20);
    const second = coordinator.runExclusive("story:1", async () => {
      secondEntered = true;
    });

    await delay(40);
    expect(secondEntered).toBe(false);
    releaseFirst();
    await Promise.all([first, second]);
    expect(secondEntered).toBe(true);
    coordinator.close();
  });

  it("reports a bounded actionable timeout with the key and wait duration", async () => {
    const path = tempPath("coordination.sqlite");
    const first = openCoordinator(path);
    const second = openCoordinator(path);
    let releaseFirst!: () => void;

    const firstRun = first.runExclusive("blocked", async () => {
      await new Promise<void>((resolveRelease) => {
        releaseFirst = resolveRelease;
      });
    });
    await delay(20);

    await expect(
      second.runExclusive("blocked", async () => undefined, { waitMs: 30 })
    ).rejects.toMatchObject({
      name: "CoordinationTimeoutError",
      key: "blocked",
      waitMs: 30,
    });
    releaseFirst();
    await firstRun;
    first.close();
    second.close();
  });

  it("does not let wrong owners renew or release the current lease row", async () => {
    const path = tempPath("coordination.sqlite");
    const coordinator = openCoordinator(path);
    let guardSnapshot!: CoordinationGuard;

    await coordinator.runExclusive("protected", async (guard) => {
      guardSnapshot = guard;
      const db = new Database(path);
      const renew = db
        .prepare(
          `UPDATE _mirk_coordination_leases
           SET expires_at_ms = ?
           WHERE namespace = ? AND key = ? AND owner_token = ? AND fencing_generation = ?`
        )
        .run(
          Date.now() + 10_000,
          "test",
          "protected",
          "wrong-owner",
          guard.fencingGeneration
        );
      const release = db
        .prepare(
          `DELETE FROM _mirk_coordination_leases
           WHERE namespace = ? AND key = ? AND owner_token = ? AND fencing_generation = ?`
        )
        .run("test", "protected", "wrong-owner", guard.fencingGeneration);
      db.close();

      expect(renew.changes).toBe(0);
      expect(release.changes).toBe(0);
      guard.assertOwned();
    });

    expect(guardSnapshot.ownerToken).toBeTruthy();
    coordinator.close();
  });

  it("aborts while waiting", async () => {
    const path = tempPath("coordination.sqlite");
    const first = openCoordinator(path);
    const second = openCoordinator(path);
    const controller = new AbortController();
    let releaseFirst!: () => void;

    const firstRun = first.runExclusive("abort", async () => {
      await new Promise<void>((resolveRelease) => {
        releaseFirst = resolveRelease;
      });
    });
    await delay(20);
    const waiting = second.runExclusive("abort", async () => undefined, {
      waitMs: 500,
      signal: controller.signal,
    });
    controller.abort(new Error("stop waiting"));

    await expect(waiting).rejects.toBeInstanceOf(CoordinationAbortedError);
    releaseFirst();
    await firstRun;
    first.close();
    second.close();
  });

  it("renews a long operation before expiry", async () => {
    const path = tempPath("coordination.sqlite");
    const coordinator = openCoordinator(path);

    await coordinator.runExclusive(
      "renewed",
      async (guard) => {
        await delay(140);
        guard.assertOwned();
      },
      { leaseMs: 60, renewEveryMs: 15 }
    );
    coordinator.close();
  });

  it("recovers an expired owner and increments fencing generation monotonically", async () => {
    const path = tempPath("coordination.sqlite");
    const coordinator = openCoordinator(path);
    const firstGeneration = await coordinator.runExclusive(
      "recover",
      async (guard) => guard.fencingGeneration
    );
    const secondGeneration = await coordinator.runExclusive(
      "recover",
      async (guard) => guard.fencingGeneration
    );

    expect(secondGeneration).toBeGreaterThan(firstGeneration);
    coordinator.close();
  });

  it("makes an expired owner observable through signal and assertOwned", async () => {
    const path = tempPath("coordination.sqlite");
    const coordinator = openCoordinator(path);
    let aborted = false;

    await expect(
      coordinator.runExclusive(
        "lost",
        async (guard) => {
          const started = Date.now();
          while (Date.now() - started < 80) {
            // Simulate a paused event loop that misses renewal.
          }
          try {
            guard.assertOwned();
          } catch (err) {
            aborted = guard.signal.aborted;
            throw err;
          }
        },
        { leaseMs: 30, renewEveryMs: 10 }
      )
    ).rejects.toBeInstanceOf(CoordinationOwnershipLostError);
    expect(aborted).toBe(true);
    coordinator.close();
  });

  it("keeps a stale guard from deleting a successor generation", async () => {
    const path = tempPath("coordination.sqlite");
    const first = openCoordinator(path);
    const second = openCoordinator(path);
    let staleGuard!: CoordinationGuard;
    let releaseFirst!: () => void;
    let secondGeneration = 0;

    const firstRun = first.runExclusive(
      "takeover",
      async (guard) => {
        staleGuard = guard;
        await new Promise<void>((resolveRelease) => {
          releaseFirst = resolveRelease;
        });
      },
      { leaseMs: 500, renewEveryMs: 100 }
    );
    await delay(20);
    const db = new Database(path);
    db.prepare(
      "UPDATE _mirk_coordination_leases SET expires_at_ms = 0 WHERE namespace = ? AND key = ?"
    ).run("test", "takeover");
    db.close();

    await second.runExclusive(
      "takeover",
      async (guard) => {
        secondGeneration = guard.fencingGeneration;
        expect(() => staleGuard.assertOwned()).toThrow(
          CoordinationOwnershipLostError
        );
        releaseFirst();
        await firstRun;
        guard.assertOwned();
      },
      { waitMs: 200, leaseMs: 500, renewEveryMs: 100 }
    );

    expect(secondGeneration).toBeGreaterThan(staleGuard.fencingGeneration);
    first.close();
    second.close();
  });

  it("does not block different keys", async () => {
    const path = tempPath("coordination.sqlite");
    const coordinator = openCoordinator(path);
    let releaseFirst!: () => void;
    let secondEntered = false;

    const first = coordinator.runExclusive("first", async () => {
      await new Promise<void>((resolveRelease) => {
        releaseFirst = resolveRelease;
      });
    });
    await delay(20);
    await coordinator.runExclusive("second", async () => {
      secondEntered = true;
    });

    expect(secondEntered).toBe(true);
    releaseFirst();
    await first;
    coordinator.close();
  });
});

describe("SqliteCoordinator two-process behavior", () => {
  beforeAll(() => {
    execFileSync("pnpm", ["--filter", "@mirk/store", "build"], {
      cwd: repoRoot,
      stdio: "inherit",
    });
  }, 60_000);

  it("excludes another process until release, then admits it", async () => {
    const root = tempPath("process-release");
    mkdirSync(root, { recursive: true });
    const dbPath = join(root, "coordination.sqlite");
    const logPath = join(root, "events.jsonl");
    const first = runWorker({
      mode: "hold",
      dbPath,
      logPath,
      key: "shared",
      holdMs: 120,
      leaseMs: 500,
    });
    await waitForMessage(first, "entered");
    const second = runWorker({
      mode: "hold",
      dbPath,
      logPath,
      key: "shared",
      holdMs: 10,
      leaseMs: 500,
    });
    await delay(50);
    expect(
      readEvents(logPath).filter((event) => event.phase === "enter")
    ).toHaveLength(1);

    await waitForExit(first);
    await waitForMessage(second, "entered");
    await waitForExit(second);
    expect(
      readEvents(logPath).filter((event) => event.phase === "enter")
    ).toHaveLength(2);
  }, 10_000);

  it("recovers after a killed owner only after the stale lease expires", async () => {
    const root = tempPath("process-kill");
    mkdirSync(root, { recursive: true });
    const dbPath = join(root, "coordination.sqlite");
    const logPath = join(root, "events.jsonl");
    const first = runWorker({
      mode: "hold",
      dbPath,
      logPath,
      key: "shared",
      holdMs: 5_000,
      leaseMs: 120,
    });
    await waitForMessage(first, "entered");
    first.kill("SIGKILL");
    await waitForExit(first, "SIGKILL");

    const second = runWorker({
      mode: "hold",
      dbPath,
      logPath,
      key: "shared",
      holdMs: 10,
      leaseMs: 120,
      waitMs: 1_000,
    });
    await waitForMessage(second, "entered");
    await waitForExit(second);
    const generations = readEvents(logPath)
      .filter((event) => event.phase === "enter")
      .map((event) => event.generation);
    expect(generations[1]).toBeGreaterThan(generations[0] ?? 0);
  }, 10_000);

  it("refuses the stale owner phase and keeps the successor lease fenced", async () => {
    const root = tempPath("process-overrun");
    mkdirSync(root, { recursive: true });
    const dbPath = join(root, "coordination.sqlite");
    const logPath = join(root, "events.jsonl");
    const stale = runWorker({
      mode: "overrun",
      dbPath,
      logPath,
      key: "shared",
      leaseMs: 80,
      blockMs: 180,
    });
    await waitForMessage(stale, "entered");
    await delay(110);
    const successor = runWorker({
      mode: "hold",
      dbPath,
      logPath,
      key: "shared",
      holdMs: 250,
      leaseMs: 200,
      waitMs: 1_000,
    });
    await waitForMessage(successor, "entered");
    await waitForExit(stale);
    const db = new Database(dbPath);
    const row = db
      .prepare(
        "SELECT fencing_generation FROM _mirk_coordination_leases WHERE namespace = ? AND key = ?"
      )
      .get("process", "shared") as { fencing_generation: number } | undefined;
    db.close();
    const events = readEvents(logPath);
    const successorGeneration = events.find(
      (event) => event.worker === successor.pid && event.phase === "enter"
    )?.generation;
    expect(
      events.some(
        (event) => event.worker === stale.pid && event.phase === "lost"
      )
    ).toBe(true);
    expect(row?.fencing_generation).toBe(successorGeneration);
    await waitForExit(successor);
  }, 10_000);

  it("contends repeatedly without overlapping recorded critical intervals", async () => {
    const root = tempPath("process-loop");
    mkdirSync(root, { recursive: true });
    const dbPath = join(root, "coordination.sqlite");
    const logPath = join(root, "events.jsonl");
    const first = runWorker({
      mode: "loop",
      dbPath,
      logPath,
      key: "shared",
      holdMs: 12,
      count: 8,
      leaseMs: 200,
    });
    const second = runWorker({
      mode: "loop",
      dbPath,
      logPath,
      key: "shared",
      holdMs: 12,
      count: 8,
      leaseMs: 200,
    });

    await Promise.all([waitForExit(first), waitForExit(second)]);
    const intervals = readEvents(logPath)
      .filter((event) => event.phase === "interval")
      .sort((a, b) => (a.start ?? 0) - (b.start ?? 0));
    expect(intervals).toHaveLength(16);
    for (let index = 1; index < intervals.length; index += 1) {
      expect(intervals[index]?.start).toBeGreaterThanOrEqual(
        intervals[index - 1]?.end ?? 0
      );
    }
  }, 10_000);
});

interface WorkerOptions {
  mode: "hold" | "overrun" | "loop";
  dbPath: string;
  logPath: string;
  key: string;
  leaseMs: number;
  waitMs?: number;
  holdMs?: number;
  blockMs?: number;
  count?: number;
}

interface WorkerEvent {
  worker: number;
  phase: string;
  generation?: number;
  start?: number;
  end?: number;
}

interface WorkerProcess {
  readonly pid?: number;
  kill(signal: NodeJS.Signals): boolean;
  once(
    event: "exit",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void
  ): this;
  on(event: "message", listener: (message: unknown) => void): this;
}

function runWorker(options: WorkerOptions): WorkerProcess {
  const workerPath = join(
    dirname(options.dbPath),
    `worker-${Math.random().toString(16).slice(2)}.mjs`
  );
  writeFileSync(workerPath, workerSource(), "utf8");
  return fork(workerPath, [JSON.stringify(options)], {
    stdio: ["ignore", "ignore", "inherit", "ipc"],
  }) as unknown as WorkerProcess;
}

function waitForMessage(child: WorkerProcess, event: string): Promise<void> {
  return new Promise((resolveMessage, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`timed out waiting for ${event}`)),
      3_000
    );
    child.once("exit", (code: number | null, signal: NodeJS.Signals | null) => {
      clearTimeout(timeout);
      reject(new Error(`worker exited before ${event}: ${code ?? signal}`));
    });
    child.on("message", (message: unknown) => {
      if ((message as { event?: string }).event === event) {
        clearTimeout(timeout);
        resolveMessage();
      }
    });
  });
}

function waitForExit(
  child: WorkerProcess,
  expectedSignal?: NodeJS.Signals
): Promise<void> {
  return new Promise((resolveExit, reject) => {
    child.once("exit", (code: number | null, signal: NodeJS.Signals | null) => {
      if (expectedSignal) {
        if (signal === expectedSignal) resolveExit();
        else
          reject(
            new Error(`expected ${expectedSignal}, got ${code ?? signal}`)
          );
        return;
      }
      if (code === 0) resolveExit();
      else reject(new Error(`worker failed: ${code ?? signal}`));
    });
  });
}

function readEvents(path: string): WorkerEvent[] {
  try {
    return readFileSync(path, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as WorkerEvent);
  } catch {
    return [];
  }
}

function workerSource(): string {
  const coordinationEntry = pathToFileURL(
    resolve(packageRoot, "dist/coordination.js")
  ).href;
  return `
    import { appendFileSync } from "node:fs";
    import { createSqliteCoordinator } from ${JSON.stringify(
      coordinationEntry
    )};

    const options = JSON.parse(process.argv[2]);
    const coordinator = createSqliteCoordinator({ path: options.dbPath, namespace: "process", busyTimeoutMs: 100 });
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const append = (event) => appendFileSync(options.logPath, JSON.stringify({ worker: process.pid, ...event }) + "\\n");

    try {
      if (options.mode === "hold") {
        await coordinator.runExclusive(options.key, async (guard) => {
          append({ phase: "enter", generation: guard.fencingGeneration });
          process.send?.({ event: "entered" });
          await sleep(options.holdMs ?? 0);
          guard.assertOwned();
          append({ phase: "exit", generation: guard.fencingGeneration });
        }, { leaseMs: options.leaseMs, renewEveryMs: Math.max(1, Math.floor(options.leaseMs / 4)), waitMs: options.waitMs ?? 3000 });
      }
      if (options.mode === "overrun") {
        await coordinator.runExclusive(options.key, async (guard) => {
          append({ phase: "enter", generation: guard.fencingGeneration });
          process.send?.({ event: "entered" });
          const started = Date.now();
          while (Date.now() - started < options.blockMs) {}
          try {
            guard.assertOwned();
          } catch {
            append({ phase: "lost", generation: guard.fencingGeneration });
          }
          await sleep(80);
        }, { leaseMs: options.leaseMs, renewEveryMs: Math.max(1, Math.floor(options.leaseMs / 4)), waitMs: options.waitMs ?? 3000 });
      }
      if (options.mode === "loop") {
        for (let index = 0; index < options.count; index += 1) {
          await coordinator.runExclusive(options.key, async (guard) => {
            const start = Date.now();
            await sleep(options.holdMs);
            guard.assertOwned();
            append({ phase: "interval", generation: guard.fencingGeneration, start, end: Date.now() });
          }, { leaseMs: options.leaseMs, renewEveryMs: Math.max(1, Math.floor(options.leaseMs / 4)), waitMs: options.waitMs ?? 3000 });
        }
      }
      coordinator.close?.();
      process.exit(0);
    } catch (error) {
      append({ phase: "error", message: error instanceof Error ? error.message : String(error) });
      process.exit(1);
    }
  `;
}
