import type {
  Client,
  InStatement,
  ResultSet,
  Transaction,
} from "@libsql/client";
import { AsyncTransactionCoordinator } from "@mirk/store/transaction";
import { Mutex, fileWriters } from "./libsql-locks.js";
import {
  LibsqlAdapterError,
  guard,
  classifyFailure,
  failure,
} from "./libsql-errors.js";

// ─── Connection and transactions ─────────────────────────────────────────────

/** The open write transaction. `minted` is the highest version number it has
 *  issued, so a rollback can keep the sequence past it. */
export interface OpenTransaction {
  execute(stmt: InStatement): Promise<ResultSet>;
  batch(stmts: InStatement[]): Promise<ResultSet[]>;
  minted: number;
  /** Remote: the client's transaction stream. Local: undefined. */
  readonly stream: Transaction | undefined;
  /** Local: releases the adapter's connection. */
  readonly release: (() => void) | undefined;
}

const OUTER_SAVEPOINT = "mirk_outer";

/**
 * Runs statements on the adapter's client, inside the calling context's open
 * transaction when there is one.
 *
 * A remote client gives each write transaction its own stream; the server
 * serializes writers with `BEGIN IMMEDIATE`. A local (`file:`/`:memory:`)
 * client has one connection, so the adapter queues its calls behind its open
 * transaction and issues `BEGIN IMMEDIATE` on that connection. Adapters in one
 * process take turns on a file before they begin, so only another process can
 * find the file locked; the adapter then retries until `busyTimeoutMs`.
 *
 * Every outermost transaction opens with a savepoint. Rolling back returns to
 * it and commits only the version sequence, so a token issued inside the
 * rolled-back work is never issued again.
 */
export class LibsqlDatabase {
  readonly transactions: AsyncTransactionCoordinator<OpenTransaction>;
  readonly local: boolean;
  closed = false;
  /** Version numbers issued by a transaction whose rollback could not be
   *  confirmed; the next transaction moves the sequence past them. */
  private floor = 0;
  /** Local: this adapter's one connection. */
  private readonly connection = new Mutex();
  /** Local: the writers of this file in this process. */
  private readonly writers: Mutex | undefined;
  /** Local: a statement on the connection failed busy. libSQL keeps such a
   *  statement active until it is garbage collected, and SQLite refuses a
   *  savepoint while it is, so the next transaction starts on a new
   *  connection. */
  private stale = false;
  /** Local: gives this adapter's share of the file's writer lock back. */
  private readonly detach: () => void;

  constructor(
    private readonly client: Client,
    url: string,
    private readonly sequenceTable: string,
    private readonly busyTimeoutMs: number,
  ) {
    this.local = client.protocol === "file";
    const writers = this.local ? fileWriters(url) : undefined;
    this.writers = writers?.mutex;
    this.detach = writers?.detach ?? (() => undefined);
    this.transactions = new AsyncTransactionCoordinator<OpenTransaction>({
      begin: () => this.begin(),
      commit: async (open) => {
        await this.commitOpen(open);
        if (this.floor <= open.minted) this.floor = 0;
      },
      rollback: (open) => this.rollbackOpen(open),
      savepoint: async (open, name) => {
        await guard(open.execute(`SAVEPOINT ${name}`));
      },
      releaseSavepoint: async (open, name) => {
        await guard(open.execute(`RELEASE SAVEPOINT ${name}`));
      },
      rollbackToSavepoint: async (open, name) => {
        await guard(
          open.batch([
            `ROLLBACK TO SAVEPOINT ${name}`,
            ...this.keepMinted(open),
          ]),
        );
      },
      end: async (open, cleanupError) => {
        if (cleanupError !== undefined)
          this.floor = Math.max(this.floor, open.minted);
        if (open.stream) {
          open.stream.close();
        } else {
          if (cleanupError !== undefined) {
            await this.client.execute("ROLLBACK").catch(() => undefined);
            this.stale = true;
          }
          open.release!();
        }
      },
    });
  }

  close(): void {
    this.closed = true;
    this.detach();
  }

  /** Run a statement in the calling context's transaction, or on its own. */
  execute(stmt: InStatement): Promise<ResultSet> {
    return this.transactions.withConnection((open) =>
      open
        ? guard(open.execute(stmt))
        : this.alone(() => this.client.execute(stmt)),
    );
  }

  /** Run `op` with the open transaction. The caller must be inside one. */
  inTransaction<T>(op: (open: OpenTransaction) => Promise<T>): Promise<T> {
    return this.transactions.withConnection((open) => {
      if (!open)
        throw new Error("internal: a libSQL write ran outside its transaction");
      return op(open);
    });
  }

  private async alone<T>(op: () => Promise<T>): Promise<T> {
    if (!this.local) return guard(op());
    const release = await this.connection.acquire();
    try {
      await this.replaceConnection();
      return await guard(op());
    } finally {
      release();
    }
  }

  /** Move the client onto a new connection. Starting a deferred transaction
   *  hands the current connection to it and makes the client open another. */
  private async replaceConnection(): Promise<void> {
    if (!this.stale) return;
    const handoff = await this.client.transaction("deferred");
    this.stale = false;
    try {
      handoff.close();
    } catch {
      // The old connection is abandoned either way; it holds no lock.
    }
  }

  private keepMinted(open: OpenTransaction): InStatement[] {
    return open.minted > 0
      ? [
          {
            sql: `UPDATE ${this.sequenceTable} SET value = max(value, ?) WHERE id = 1`,
            args: [open.minted],
          },
        ]
      : [];
  }

  private async begin(): Promise<OpenTransaction> {
    if (this.closed)
      throw new LibsqlAdapterError(
        "adapter-closed",
        "The libSQL adapter is closed.",
      );
    const minted = this.floor;
    const opening: InStatement[] = [`SAVEPOINT ${OUTER_SAVEPOINT}`];
    if (minted > 0) {
      opening.push({
        sql: `UPDATE ${this.sequenceTable} SET value = max(value, ?) WHERE id = 1`,
        args: [minted],
      });
    }
    if (this.local) {
      const releaseWriters = await this.writers!.acquire();
      const releaseConnection = await this.connection.acquire();
      const release = () => {
        releaseConnection();
        releaseWriters();
      };
      try {
        await this.whileBusy(async () => {
          await this.replaceConnection();
          try {
            await this.client.execute("BEGIN IMMEDIATE");
          } catch (error) {
            if (classifyFailure(error) === "busy") {
              this.stale = true;
              await this.replaceConnection();
            }
            throw error;
          }
        });
        const open: OpenTransaction = {
          execute: (stmt) => this.client.execute(stmt),
          batch: async (stmts) => {
            const results: ResultSet[] = [];
            for (const stmt of stmts)
              results.push(await this.client.execute(stmt));
            return results;
          },
          minted,
          stream: undefined,
          release,
        };
        try {
          await guard(open.batch(opening));
        } catch (error) {
          await this.client.execute("ROLLBACK").catch(() => undefined);
          throw error;
        }
        return open;
      } catch (error) {
        release();
        throw error;
      }
    }
    return this.whileBusy(async () => {
      const stream = await this.client.transaction("write");
      try {
        // The client sends BEGIN IMMEDIATE with the first statement; the server
        // holds it until no other transaction has the write lock.
        await stream.batch(opening);
      } catch (error) {
        stream.close();
        throw error;
      }
      return {
        execute: (stmt) => stream.execute(stmt),
        batch: (stmts) => stream.batch(stmts),
        minted,
        stream,
        release: undefined,
      };
    });
  }

  private async commitOpen(open: OpenTransaction): Promise<void> {
    try {
      if (open.stream) await open.stream.commit();
      else await this.whileBusy(() => this.client.execute("COMMIT"));
    } catch (error) {
      if (error instanceof LibsqlAdapterError) throw error;
      const code = classifyFailure(error);
      if (code === undefined) throw error;
      throw failure(
        code === "connection-lost" ? "commit-indeterminate" : code,
        error,
      );
    }
  }

  /** Roll back the work. When it issued version numbers, return to the
   *  opening savepoint and commit only the sequence past them. If that commit
   *  fails, the work is still not applied: ROLLBACK TO already discarded it, so
   *  the failure is reported as definite. Only the sequence is uncertain, and
   *  `end` keeps its floor so this adapter's next transaction moves the
   *  sequence past those numbers before it issues any. */
  private async rollbackOpen(open: OpenTransaction): Promise<void> {
    if (open.minted === 0) {
      if (open.stream) await guard(open.stream.rollback());
      else await guard(this.client.execute("ROLLBACK"));
      return;
    }
    await guard(
      open.batch([
        `ROLLBACK TO SAVEPOINT ${OUTER_SAVEPOINT}`,
        ...this.keepMinted(open),
      ]),
    );
    if (open.stream) await guard(open.stream.commit());
    else await this.whileBusy(() => this.client.execute("COMMIT"));
    if (this.floor <= open.minted) this.floor = 0;
  }

  /** Retry `attempt` while the database reports its write lock busy. */
  private async whileBusy<T>(attempt: () => Promise<T>): Promise<T> {
    const started = Date.now();
    for (let tries = 0; ; tries++) {
      try {
        return await attempt();
      } catch (error) {
        const code = classifyFailure(error);
        if (code !== "busy")
          throw code === undefined ? error : failure(code, error);
        if (this.local) this.stale = true;
        if (Date.now() - started >= this.busyTimeoutMs)
          throw failure("busy", error);
        await new Promise((resolve) =>
          setTimeout(resolve, Math.min(2 ** tries, 50)),
        );
      }
    }
  }
}
