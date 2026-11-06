import type { JsonValue } from '@mirk/store/atomic';
import { systemClock } from '@mirk/store/coordination/core';
import { runClaim, JobsStore } from '@mirk/jobs';
import type { BlockedDecision, EnqueueInput, JobClaim, JobRecord, StartInput, JobListOptions } from '@mirk/jobs';

export function jobsConformanceTarget(jobs: JobsStore, setNow: (value: number) => void): Record<string, unknown> {
  const claims = new Map<string, JobClaim>();
  let command = 0;
  const key = () => ({key: `command-${++command}`});
  const claim = (id: string) => { const value = claims.get(id); if (!value) throw new Error('Missing fixture claim'); return value; };
  return {
    setNow: (value: number) => {setNow(value); return null;},
    enqueue: async (id: string, queue: string, payload: JsonValue, priority = 0) => (await jobs.enqueue({id,queue,payload,priority},key())).value,
    enqueueCommand: async (input: EnqueueInput, commandKey: string) => (await jobs.enqueue(input,{key:commandKey})).value,
    rememberClaim: (id: string, alias: string) => { claims.set(alias,claim(id)); return null; },
    corruptRecord: async (id: string, patch: Partial<JobRecord>) => { const record = (await jobs.get(id))!.value; await jobs.options.store.put(jobs.collection,{...record,...patch}); return null; },
    start: async (input: StartInput, commandKey: string) => {const result=await jobs.start(input,{key:commandKey}); return {...result,job:result.job.value};},
    listFiltered: async (filter: JobListOptions) => (await jobs.list(filter)).map(j=>j.value),
    corruptActiveSlot: async (queue: string, activeKey: string, id: string) => {await jobs.options.store.set('mirk-jobs-active:'+JSON.stringify([jobs.collection,queue,activeKey]),id); return null;},
    seedLegacy: async (id: string) => {const job=(await jobs.get(id))!.value; const {activeKey:_k,subject:_s,kind:_t,...legacy}=job;await jobs.options.store.put(jobs.collection,{...legacy,schemaVersion:1});return null;},
    runClaimNoop: async (id: string) => runClaim(jobs,claim(id),{leaseMs:20,renewEveryMs:5,commandKey:key().key,clock:{...systemClock,now:jobs.options.now ?? Date.now}},async()=> 'work-done'),
    get: async (id: string) => (await jobs.get(id))?.value ?? null,
    list: async (queue: string) => (await jobs.list({queue})).map(j => j.value),
    claim: async (id: string, leaseMs: number) => { const value = await jobs.claim(id,{...key(),leaseMs}); if(value) claims.set(value.jobId,value); return value; },
    claimNext: async (queue: string, leaseMs: number) => { const value = await jobs.claimNext(queue,{...key(),leaseMs}); if(value) claims.set(value.jobId,value); return value; },
    renew: async (id: string, leaseMs: number) => (await jobs.renew(claim(id),leaseMs,key())).value,
    checkpoint: async (id: string, value: JsonValue) => (await jobs.checkpoint(claim(id),value,key())).value,
    complete: async (id: string, value: JsonValue) => (await jobs.complete(claim(id),value,key())).value,
    fail: async (id: string, value: JsonValue) => (await jobs.fail(claim(id),value,key())).value,
    retry: async (id: string, availableAt: number) => (await jobs.retry(claim(id),availableAt,key())).value,
    block: async (id: string, value: JsonValue) => (await jobs.block(claim(id),value,key())).value,
    requestCancel: async (id: string) => (await jobs.requestCancel(id,key())).value,
    acknowledgeCancel: async (id: string) => (await jobs.acknowledgeCancel(claim(id),key())).value,
    recoverExpired: async (id: string) => (await jobs.recoverExpired(id,claim(id).generation,key())).value,
    resolveBlockedCommand: async (id: string, decision: BlockedDecision, commandKey: string) => (await jobs.resolveBlocked(id,(await jobs.get(id))!.version,decision,{key:commandKey})).value,
    resolveBlocked: async (id: string, decision: BlockedDecision) => (await jobs.resolveBlocked(id,(await jobs.get(id))!.version,decision,key())).value,
    updateQueued: async (id: string, patch: {priority?: number; availableAt?: number}) => (await jobs.updateQueued(id,(await jobs.get(id))!.version,patch,key())).value,
    requeueTerminal: async (id: string, patch: {availableAt?: number}) => (await jobs.requeueTerminal(id,(await jobs.get(id))!.version,patch,key())).value,
    removeTerminal: async (id: string) => jobs.removeTerminal(id,(await jobs.get(id))!.version,key()),
  };
}
