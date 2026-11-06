import { InMemoryStore } from "../backends/memory.js";
import { InMemoryLogStore } from "../log/memory.js";
import { createMemoryTransactions } from "../memory-transactions.js";
import type { CoordinationLease } from "./core.js";
import {
  createMemoryCoordinator,
  createMemoryCoordinationState,
} from "./memory.js";

export async function memoryTransactionRollback(): Promise<
  Record<string, unknown>
> {
  const kv = new InMemoryStore();
  const log = new InMemoryLogStore();
  const state = createMemoryCoordinationState();
  const coordinator = createMemoryCoordinator({
    state,
    ownerTokenFactory: () => "repeated",
    clock: {
      now: () => 1000,
      sleep: async () => {
        throw new Error("unexpected sleep");
      },
    },
  });
  const transactions = createMemoryTransactions({
    kv,
    log,
    coordination: state,
  });
  const acquire = async (key: string) => {
    const result = await coordinator.tryAcquire(key, { leaseMs: 100 });
    if (result.status !== "acquired") throw new Error(result.status);
    return result.lease;
  };
  const prior = await acquire("prior");
  let escaped!: CoordinationLease;
  let prematureAbort = false;
  let assertionFailed = false;
  const rollback = new Error("rollback");
  try {
    await transactions.transaction(async () => {
      kv.set("record", true);
      log.append("history", true);
      await prior.renew(500);
      await prior.release();
      try {
        prior.assertOwned();
      } catch {
        assertionFailed = true;
      }
      prematureAbort = prior.signal.aborted;
      escaped = await acquire("provisional");
      throw rollback;
    });
  } catch (error) {
    if (error !== rollback) throw error;
  }
  prior.assertOwned();
  const next = await acquire("provisional");
  return {
    recordPresent: kv.has("record"),
    historyLength: log.list("history").length,
    priorExpiry: prior.expiresAt,
    priorAborted: prior.signal.aborted,
    assertionFailed,
    prematureAbort,
    provisionalAborted: escaped.signal.aborted,
    nextGeneration: next.fencingGeneration,
    staleRenewed: await escaped.renew(100),
    staleReleased: await escaped.release(),
  };
}
