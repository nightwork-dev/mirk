// Real libSQL databases for the transaction, conformance and fencing suites:
// a local file, a loopback `sqld` server (MIRK_LIBSQL_SERVER names the binary),
// and a hosted Turso database (MIRK_LIBSQL_TURSO_URL and MIRK_LIBSQL_TURSO_TOKEN).
// Server-backed databases share one server, so each fresh database is a fresh
// table prefix, and its tables are dropped when it is disposed.

import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createClient, type Client } from "@libsql/client";
import { createClient as createWebClient } from "@libsql/client/web";

import { LibsqlAdapter as NodeAdapter } from "../libsql-adapter.js";
import type { LibsqlAdapterOptions } from "../libsql-core.js";
import { LibsqlAdapter as RemoteAdapter } from "../remote.js";

export type Adapter = NodeAdapter | RemoteAdapter;
export type ExtraOptions = Omit<LibsqlAdapterOptions, "url" | "authToken" | "client" | "tablePrefix">;

/** One empty database. Every `open` is a separate adapter with its own client. */
export interface TestDatabase {
  open(extra?: ExtraOptions): Promise<Adapter>;
  /** The prefix of every table in this database. */
  readonly tablePrefix: string;
  /** A plain client on the same database, for setting up raw rows. */
  client(): Client;
  dispose(): Promise<void>;
}

export interface Target {
  name: string;
  /** Remote targets use the portable atomic limits. */
  remote: boolean;
  fresh(): Promise<TestDatabase>;
}

const runId = randomUUID().replaceAll("-", "").slice(0, 10);
let databases = 0;

export function fileTarget(): Target {
  return {
    name: "file:",
    remote: false,
    async fresh() {
      const directory = mkdtempSync(join(tmpdir(), "mirk-libsql-tx-"));
      const url = `file:${join(directory, "store.db")}`;
      const opened: Adapter[] = [];
      return {
        tablePrefix: "",
        client: () => createClient({ url }),
        async open(extra) {
          const adapter = await NodeAdapter.open({ url, ...extra });
          opened.push(adapter);
          return adapter;
        },
        async dispose() {
          for (const adapter of opened) adapter.close();
          rmSync(directory, { recursive: true, force: true });
        },
      };
    },
  };
}

/** A database on a shared server: every table carries a per-database prefix. */
function prefixedTarget(
  name: string,
  connection: () => { url: string; authToken?: string },
  openAdapter: (options: LibsqlAdapterOptions) => Promise<Adapter>,
): Target {
  return {
    name,
    remote: true,
    async fresh() {
      const tablePrefix = `mirk_${runId}_${++databases}_`;
      const opened: Adapter[] = [];
      return {
        tablePrefix,
        client: () => createWebClient(connection()),
        async open(extra) {
          const adapter = await openAdapter({ ...connection(), tablePrefix, ...extra });
          opened.push(adapter);
          return adapter;
        },
        async dispose() {
          for (const adapter of opened) adapter.close();
          await dropTables(connection(), tablePrefix);
        },
      };
    },
  };
}

/** Drop every table whose name starts with `prefix`. */
export async function dropTables(
  connection: { url: string; authToken?: string },
  prefix: string,
): Promise<number> {
  const client = createWebClient(connection);
  let dropped = 0;
  try {
    for (let pass = 0; pass < 5; pass++) {
      const rs = await client.execute({
        sql: "SELECT name FROM sqlite_master WHERE type = 'table' AND substr(name, 1, length(?)) = ? ORDER BY name DESC",
        args: [prefix, prefix],
      });
      if (rs.rows.length === 0) break;
      for (const row of rs.rows) {
        try {
          await client.execute(`DROP TABLE IF EXISTS "${String(row.name).replaceAll('"', '""')}"`);
          dropped += 1;
        } catch {
          // A vector index's shadow table goes with its table; retry the rest.
        }
      }
    }
  } finally {
    client.close();
  }
  return dropped;
}

export interface Sqld {
  readonly url: string;
  /** Kill the server process (SIGKILL by default) without cleanup. */
  kill(signal?: NodeJS.Signals): Promise<void>;
  /** Start the server again on the same port and data directory. */
  restart(): Promise<void>;
  stop(): Promise<void>;
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (typeof address !== "object" || address === null) throw new Error("no port");
  return address.port;
}

/** Start an isolated loopback `sqld` with temporary data. */
export async function startSqld(binary: string): Promise<Sqld> {
  const directory = mkdtempSync(join(tmpdir(), "mirk-sqld-"));
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  let child: ChildProcess | undefined;

  async function launch(): Promise<void> {
    child = spawn(
      binary,
      ["--db-path", join(directory, "db"), "--http-listen-addr", `127.0.0.1:${port}`, "--no-welcome"],
      { stdio: "ignore" },
    );
    const deadline = Date.now() + 15_000;
    for (;;) {
      try {
        const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(500) });
        if (response.ok) return;
      } catch {
        // Not listening yet.
      }
      if (Date.now() > deadline) throw new Error("sqld did not start");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  async function kill(signal: NodeJS.Signals = "SIGKILL"): Promise<void> {
    const running = child;
    child = undefined;
    if (!running || running.exitCode !== null) return;
    const exited = new Promise((resolve) => running.once("exit", resolve));
    running.kill(signal);
    await exited;
  }

  await launch();
  return {
    url,
    kill,
    restart: launch,
    async stop() {
      await kill("SIGTERM");
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

/** A target on a running sqld, through the engine-free remote entry. */
export function sqldTarget(server: () => Sqld): Target {
  return prefixedTarget("sqld", () => ({ url: server().url }), (options) => RemoteAdapter.open(options));
}

export const tursoConnection =
  process.env.MIRK_LIBSQL_TURSO_URL && process.env.MIRK_LIBSQL_TURSO_TOKEN
    ? { url: process.env.MIRK_LIBSQL_TURSO_URL, authToken: process.env.MIRK_LIBSQL_TURSO_TOKEN }
    : undefined;

/** The hosted Turso test database, through the Node entry. */
export function tursoTarget(): Target {
  return prefixedTarget("turso", () => tursoConnection!, (options) => NodeAdapter.open(options));
}

/** The prefix every Turso table of this run starts with. */
export const runPrefix = `mirk_${runId}_`;

export const sqldBinary = process.env.MIRK_LIBSQL_SERVER;
