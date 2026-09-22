import { describe, expect, it } from "vitest";
import { fork } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import Database from "better-sqlite3";

import { SqliteAdapter } from "./adapters/sqlite.js";
import type { AtomicMutationRequest } from "./index.js";

const committedMutation: AtomicMutationRequest = {
  conditions: [{ target: { kind: "key", key: "ledger" }, expected: "missing" }],
  operations: [{ op: "set", key: "ledger", value: { balance: 10 } }],
  idempotency: { key: "open-ledger" },
};

describe("SQLite crash recovery", () => {
  it("a process that dies mid-write leaves the database consistent and every committed write intact", async () => {
    const root = join(tmpdir(), `mirk-crash-${process.pid}-${Date.now()}`);
    mkdirSync(root, { recursive: true });
    const dbPath = join(root, "crash.sqlite");
    const workerPath = resolve(root, "worker.mjs");
    const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const adapterEntry = pathToFileURL(
      resolve(packageRoot, "dist/adapters/sqlite.js")
    ).href;
    writeFileSync(
      workerPath,
      `
      import { statSync } from "node:fs";
      import { SqliteAdapter } from ${JSON.stringify(adapterEntry)};
      const walBytes = () => statSync(options.dbPath + "-wal").size;
      const options = JSON.parse(process.argv[2]);
      const adapter = new SqliteAdapter({ path: options.dbPath, busyTimeoutMs: 5_000 });
      adapter.kv.set("committed", 1);
      adapter.kv.put("notes", { id: "kept", body: "committed" });
      adapter.kv.mutateAtomically(options.mutation);
      const walBefore = walBytes();
      adapter.transaction(() => {
        adapter.kv.set("uncommitted", 2);
        adapter.kv.put("notes", { id: "lost", body: "uncommitted" });
        // Larger than better-sqlite3's 16 MB page cache, so SQLite must spill uncommitted pages
        // into the WAL; recovery then has real uncommitted frames to discard.
        adapter.kv.set("uncommitted-large", "x".repeat(32 * 1024 * 1024));
        process.send({ phase: "in-transaction", walBefore, walInside: walBytes() });
        // Block inside the open write transaction until the parent kills us.
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000);
      }, "immediate");
      process.send("transaction-returned");
    `,
      "utf8"
    );

    try {
      const outcome = await new Promise<{ signal: string | null; messages: unknown[] }>(
        (resolveExit, reject) => {
          const messages: unknown[] = [];
          const child = fork(
            workerPath,
            [JSON.stringify({ dbPath, mutation: committedMutation })],
            { stdio: ["ignore", "ignore", "inherit", "ipc"] }
          ) as unknown as {
            kill(signal: string): boolean;
            on(event: string, listener: (...args: any[]) => void): void;
          };
          child.on("message", (message: unknown) => {
            messages.push(message);
            if ((message as { phase?: string }).phase === "in-transaction") child.kill("SIGKILL");
          });
          child.on("error", reject);
          child.on("exit", (_code: number | null, signal: string | null) => resolveExit({ signal, messages }));
        }
      );
      expect(outcome.signal).toBe("SIGKILL");
      expect(outcome.messages).toHaveLength(1);
      const inside = outcome.messages[0] as { phase: string; walBefore: number; walInside: number };
      expect(inside.phase).toBe("in-transaction");
      expect(inside.walInside).toBeGreaterThan(inside.walBefore);

      const adapter = new SqliteAdapter({ path: dbPath, busyTimeoutMs: 1_000 });
      try {
        expect(adapter.kv.get("committed")).toBe(1);
        expect(adapter.kv.getById("notes", "kept")).toEqual({
          id: "kept",
          body: "committed",
        });
        expect(adapter.kv.get("ledger")).toEqual({ balance: 10 });

        expect(adapter.kv.has("uncommitted")).toBe(false);
        expect(adapter.kv.has("uncommitted-large")).toBe(false);
        expect(adapter.kv.getById("notes", "lost")).toBeNull();

        expect(adapter.kv.mutateAtomically(committedMutation).status).toBe(
          "replayed"
        );

        // The dead process's write lock is gone: a new write transaction commits.
        adapter.transaction(() => adapter.kv.set("after-crash", 3), "immediate");
        expect(adapter.kv.get("after-crash")).toBe(3);

        expect(adapter.checkpoint("truncate").busy).toBe(0);
      } finally {
        adapter.close();
      }

      const raw = new Database(dbPath, { readonly: true });
      try {
        expect(raw.pragma("integrity_check", { simple: true })).toBe("ok");
      } finally {
        raw.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});
