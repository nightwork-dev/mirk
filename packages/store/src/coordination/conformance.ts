import { memoryTransactionRollback } from "./transaction-conformance.js";
import type {
  AsyncCoordinator,
  CoordinationClock,
  CoordinationLease,
} from "./core.js";

export function coordinationApi(
  create: (clock: CoordinationClock) => AsyncCoordinator,
): Record<string, unknown> {
  let now = 1000;
  const clock: CoordinationClock = {
    now: () => now,
    sleep: async () => {
      throw new Error("Unexpected timed wait in immediate lease scenario.");
    },
  };
  const coordinator = create(clock);
  const leases = new Map<string, CoordinationLease>();
  return {
    advance: (ms: number) => {
      now += ms;
      return now;
    },
    acquire: async (handle: string, key: string, leaseMs: number) => {
      const result = await coordinator.tryAcquire(key, { leaseMs });
      if (result.status !== "acquired") return result;
      leases.set(handle, result.lease);
      return {
        status: result.status,
        fencingGeneration: result.lease.fencingGeneration,
        expiresAt: result.lease.expiresAt,
      };
    },
    renew: (handle: string, leaseMs: number) =>
      leases.get(handle)!.renew(leaseMs),
    release: (handle: string) => leases.get(handle)!.release(),
    owned: (handle: string) => {
      try {
        leases.get(handle)!.assertOwned();
        return true;
      } catch {
        return false;
      }
    },
  };
}

export function memoryTransactionApi(): Record<string, unknown> {
  return { memoryTransactionRollback };
}
