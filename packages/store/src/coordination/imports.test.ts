import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  SqliteCoordinator as Historical,
  createSqliteCoordinator as historicalFactory,
} from "../coordination.js";
import { SqliteCoordinator, createSqliteCoordinator } from "./sqlite.js";

describe("coordination package entry imports", () => {
  it("re-exports the actual SQLite class and factory from the historical entry", () => {
    expect(Historical).toBe(SqliteCoordinator);
    expect(historicalFactory).toBe(createSqliteCoordinator);
    const coordinator = new Historical({ path: ":memory:" });
    coordinator.close();
  });
  it("propagates uncertain SQLite ownership reads without aborting a valid handle", async () => {
    const root = mkdtempSync(join(tmpdir(), "mirk-lease-uncertainty-"));
    const path = join(root, "leases.db");
    const coordinator = new SqliteCoordinator({ path });
    const lock = new Database(path);
    try {
      const result = await coordinator.tryAcquire("key");
      if (result.status !== "acquired") throw new Error(result.status);
      lock.exec("BEGIN EXCLUSIVE");
      expect(() => result.lease.assertOwned()).toThrow(
        expect.objectContaining({ code: "SQLITE_BUSY" }),
      );
      expect(result.lease.signal.aborted).toBe(false);
      lock.exec("ROLLBACK");
      result.lease.assertOwned();
      await result.lease.release();
    } finally {
      lock.close();
      coordinator.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
  it("imports built core and memory entries with native bindings forbidden", () => {
    const loader =
      "data:text/javascript," +
      encodeURIComponent(`export async function resolve(specifier, context, next) {
      if (specifier === 'better-sqlite3' || specifier === 'node:sqlite') throw Error('native import forbidden');
      return next(specifier, context);
    }`);
    const memory = new URL("../../dist/coordination/memory.js", import.meta.url)
      .href;
    const core = new URL("../../dist/coordination/core.js", import.meta.url)
      .href;
    const output = execFileSync(
      process.execPath,
      [
        "--loader",
        loader,
        "--input-type=module",
        "-e",
        `
      const core = await import(${JSON.stringify(core)});
      const memory = await import(${JSON.stringify(memory)});
      const c = memory.createMemoryCoordinator({state: memory.createMemoryCoordinationState()});
      const result = await c.tryAcquire('key');
      console.log(result.status, typeof core.CoordinationTimeoutError);
    `,
      ],
      {
        cwd: fileURLToPath(new URL("../../", import.meta.url)),
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    expect(output.trim()).toBe("acquired function");
  });
});
