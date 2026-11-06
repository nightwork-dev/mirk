import {
  CoordinationOwnershipLostError,
  type CoordinationLease,
  type CoordinationClock,
  type CoordinationAbortSignal,
} from "./core.js";
import type { LeaseBackend, LeaseIdentity } from "./engine.js";
import { positiveInteger } from "./validation.js";

export class ManagedLease implements CoordinationLease {
  readonly #controller = new AbortController();
  readonly signal: CoordinationAbortSignal = this.#controller.signal;
  readonly key: string;
  readonly ownerToken: string;
  readonly fencingGeneration: number;
  #expiresAt: number;
  get expiresAt(): number {
    this.backend.participation?.check();
    return this.#expiresAt;
  }
  constructor(
    readonly backend: LeaseBackend,
    readonly namespace: string,
    readonly clock: CoordinationClock,
    identity: LeaseIdentity,
  ) {
    this.key = identity.key;
    this.ownerToken = identity.ownerToken;
    this.fencingGeneration = identity.fencingGeneration;
    this.#expiresAt = identity.expiresAt;
  }
  assertOwned(): void {
    this.backend.participation?.check();
    if (this.signal.aborted) throw this.signal.reason;
    if (!this.backend.isOwned(this)) {
      throw this.#lost();
    }
  }
  async renew(
    leaseMs: number,
    signal: CoordinationAbortSignal = this.signal,
  ): Promise<boolean> {
    const work = () => this.#renew(leaseMs, signal);
    return this.backend.participation
      ? this.backend.participation.run(work)
      : work();
  }
  async #renew(
    leaseMs: number,
    signal: CoordinationAbortSignal,
  ): Promise<boolean> {
    positiveInteger(leaseMs, "leaseMs");
    if (this.signal.aborted) return false;
    while (
      this.clock.now() < this.expiresAt &&
      !this.signal.aborted &&
      !signal.aborted
    ) {
      const expiry = this.backend.renew(this, leaseMs);
      if (expiry === "unavailable") {
        try {
          await this.clock.sleep(
            Math.max(0, Math.min(5, this.expiresAt - this.clock.now())),
            signal,
          );
        } catch (error) {
          if (signal.aborted) return false;
          throw error;
        }
        continue;
      }
      if (expiry === undefined) {
        this.#lost();
        return false;
      }
      const previous = this.#expiresAt;
      this.backend.participation?.afterRollback(() => {
        this.#expiresAt = previous;
      });
      this.#expiresAt = expiry;
      return true;
    }
    if (!signal.aborted) this.#lost();
    return false;
  }
  async release(): Promise<boolean> {
    const work = () => this.#release();
    return this.backend.participation
      ? this.backend.participation.run(work)
      : work();
  }
  async #release(): Promise<boolean> {
    while (this.clock.now() < this.expiresAt) {
      const released = this.backend.release(this);
      if (released === "unavailable") {
        await this.clock.sleep(
          Math.max(0, Math.min(5, this.expiresAt - this.clock.now())),
        );
        continue;
      }
      this.#lost();
      return released;
    }
    this.#lost();
    return false;
  }
  abort(reason: unknown): void {
    if (!this.signal.aborted) this.#controller.abort(reason);
  }
  #lost(): CoordinationOwnershipLostError {
    const error = new CoordinationOwnershipLostError(
      this.key,
      this.ownerToken,
      this.fencingGeneration,
      this.namespace,
    );
    const abort = () => this.abort(error);
    if (this.backend.participation)
      this.backend.participation.afterCommit(abort);
    else abort();
    return error;
  }
}
