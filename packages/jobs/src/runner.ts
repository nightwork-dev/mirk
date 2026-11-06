import { systemClock, type CoordinationClock } from '@mirk/store/coordination/core';
import { canonicalJson } from '@mirk/store/atomic';
import type { JobsStore } from './index.js';
import type { JobClaim } from './types.js';
import { JobsError } from './types.js';
import { validateClaim } from './validation.js';

export interface RunClaimOptions {
  leaseMs: number;
  renewEveryMs: number;
  commandKey: string;
  clock?: CoordinationClock;
  signal?: AbortSignal;
}

export async function runClaim<T>(jobs: JobsStore, claim: JobClaim, options: RunClaimOptions, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  validateClaim(claim); claim = structuredClone(claim); options = {...options};
  if (!Number.isSafeInteger(options.leaseMs) || options.leaseMs <= 0 || !Number.isSafeInteger(options.renewEveryMs) || options.renewEveryMs <= 0 || options.renewEveryMs >= options.leaseMs || typeof options.commandKey !== 'string' || !options.commandKey) throw new JobsError('invalid-input');
  const clock = options.clock ?? systemClock;
  const controller = new AbortController(); const sleep = new AbortController();
  let stopped = false; let sequence = 0;
  const abort = (reason: unknown) => {controller.abort(reason); sleep.abort(reason);};
  const external = () => abort(options.signal?.reason);
  options.signal?.addEventListener('abort',external,{once:true});
  if (options.signal?.aborted) external();
  const check = () => jobs.options.transactions.transaction(async () => {
    if (controller.signal.aborted) throw controller.signal.reason;
    const current = await jobs.get(claim.jobId); const now = clock.now();
    if (!current || current.value.state !== 'leased' || current.value.ownerToken !== claim.ownerToken || current.value.generation !== claim.generation || current.value.expiresAt === null || current.value.expiresAt <= now) throw new JobsError('stale-claim');
    if (current.value.cancellation) throw new JobsError('cancel-requested');
  });
  const renew = async () => {
    await check();
    const key = canonicalJson(['runClaim',options.commandKey,claim.jobId,claim.ownerToken,claim.generation,sequence++]);
    await jobs.renew(claim,options.leaseMs,{key});
    await check();
  };
  let monitor: Promise<void> = Promise.resolve();
  try {
    await renew();
    monitor = (async () => {
      try {
        while (!stopped) {
          await clock.sleep(options.renewEveryMs,sleep.signal);
          if (!stopped) await renew();
        }
      } catch (error) {if (!stopped) abort(error);}
    })();
    const result = await work(controller.signal);
    stopped = true; sleep.abort(); await monitor;
    await check();
    if (controller.signal.aborted) throw controller.signal.reason;
    return result;
  } finally {
    if (!stopped) {stopped = true; sleep.abort(); await monitor;}
    options.signal?.removeEventListener('abort',external);
  }
}
