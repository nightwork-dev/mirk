import type { AsyncStoreTransactions } from "./transaction-types.js";
import type { InMemoryStore } from "./backends/memory.js";
import type { InMemoryLogStore } from "./log/memory.js";
import { memoryParticipant } from "./memory-participant.js";
import { AsyncTransactionCoordinator } from "./transaction.js";

export function createMemoryTransactions(stores: {
  kv: InMemoryStore;
  log: InMemoryLogStore;
}): AsyncStoreTransactions {
  const participants = [memoryParticipant(stores.kv), memoryParticipant(stores.log)];
  if (participants.some((participant) => participant.admission)) {
    throw new TypeError("A memory store already belongs to a transaction domain");
  }
  let active = false;
  let tail: Promise<void> = Promise.resolve();
  let unlock: (() => void) | undefined;
  const snapshot = () => participants.map((participant) => participant.checkpoint());
  const restore = (states: unknown[]) => participants.forEach((participant, index) => participant.restore(states[index]));
  const coordinator = new AsyncTransactionCoordinator<Map<string, unknown[]>>({
    async begin() {
      const prior = tail;
      tail = new Promise<void>((resolve) => {
        const release = resolve;
        void prior.then(() => { unlock = release; });
      });
      await prior;
      active = true;
      return new Map([["outer", snapshot()]]);
    },
    commit() {},
    rollback(connection) { restore(connection.get("outer")!); },
    savepoint(connection, name) { connection.set(name, snapshot()); },
    releaseSavepoint(connection, name) { connection.delete(name); },
    rollbackToSavepoint(connection, name) { restore(connection.get(name)!); },
    end() {
      active = false;
      const release = unlock;
      unlock = undefined;
      release?.();
    },
  });
  const admission = {
    check() {
      if (coordinator.synchronousConnection() === undefined && active) {
        throw new Error("Memory store is owned by another transaction scope");
      }
    },
    async run<T>(work: () => T | Promise<T>): Promise<T> {
      return coordinator.withConnection(async (connection) => {
        if (connection !== undefined) return work();
        while (active) await tail;
        return work();
      });
    },
  };
  for (const participant of participants) participant.admission = admission;
  return coordinator;
}
