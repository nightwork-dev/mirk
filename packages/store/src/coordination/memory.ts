import type { AsyncCoordinator, CoordinationOptions } from "../coordination.js";
import {
  LeaseCoordinator,
  systemClock,
  type LeaseBackend,
  type LeaseIdentity,
} from "./engine.js";

export interface MemoryCoordinationState {
  readonly leases: Map<
    string,
    {
      key: string;
      ownerToken: string;
      fencingGeneration: number;
      expiresAt: number;
    }
  >;
  readonly generations: Map<string, number>;
}
export function createMemoryCoordinationState(): MemoryCoordinationState {
  return { leases: new Map(), generations: new Map() };
}
export interface MemoryCoordinatorOptions extends CoordinationOptions {
  state: MemoryCoordinationState;
}
export function createMemoryCoordinator(
  options: MemoryCoordinatorOptions,
): AsyncCoordinator {
  const clock = options.clock ?? systemClock;
  const prefix = JSON.stringify(options.namespace ?? "default");
  const address = (key: string) => `${prefix}:${JSON.stringify(key)}`;
  const owned = (lease: LeaseIdentity, now = clock.now()) => {
    const current = options.state.leases.get(address(lease.key));
    return current &&
      current.ownerToken === lease.ownerToken &&
      current.fencingGeneration === lease.fencingGeneration &&
      current.expiresAt > now
      ? current
      : undefined;
  };
  const backend: LeaseBackend = {
    acquire(key, ownerToken, leaseMs) {
      const id = address(key);
      const current = options.state.leases.get(id);
      const now = clock.now();
      if (current && current.expiresAt > now)
        return { status: "held", expiresAt: current.expiresAt };
      const fencingGeneration = (options.state.generations.get(id) ?? 0) + 1;
      if (!Number.isSafeInteger(fencingGeneration))
        throw new Error("Coordination fencing generation exhausted.");
      options.state.generations.set(id, fencingGeneration);
      const expiresAt = now + leaseMs;
      options.state.leases.set(id, {
        key,
        ownerToken,
        fencingGeneration,
        expiresAt,
      });
      return { status: "acquired", fencingGeneration, expiresAt };
    },
    renew(lease, leaseMs) {
      const now = clock.now();
      const current = owned(lease, now);
      if (!current) return undefined;
      current.expiresAt = now + leaseMs;
      return current.expiresAt;
    },
    release(lease) {
      return Boolean(
        owned(lease) && options.state.leases.delete(address(lease.key)),
      );
    },
    isOwned(lease) {
      return Boolean(owned(lease));
    },
  };
  return new LeaseCoordinator(backend, options);
}
