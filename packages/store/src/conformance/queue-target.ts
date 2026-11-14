import type { JsonValue } from '@mirk/store/atomic';
import { systemClock } from '@mirk/store/coordination/core';
import { runClaim, QueueStore } from '@mirk/queue';
import type { BlockedDecision, EnqueueInput, QueueClaim, QueueItem, StartInput, QueueListOptions } from '@mirk/queue';

export function queueConformanceTarget(q: QueueStore, setNow: (value: number) => void): Record<string, unknown> {
  const claims = new Map<string, QueueClaim>();
  let command = 0;
  const key = () => ({key: `command-${++command}`});
  const claim = (id: string) => { const value = claims.get(id); if (!value) throw new Error('Missing fixture claim'); return value; };
  return {
    setNow: (value: number) => {setNow(value); return null;},
    enqueue: async (id: string, queue: string, payload: JsonValue, priority = 0) => (await q.enqueue({id,queue,payload,priority},key())).value,
    enqueueCommand: async (input: EnqueueInput, commandKey: string) => (await q.enqueue(input,{key:commandKey})).value,
    rememberClaim: (id: string, alias: string) => { claims.set(alias,claim(id)); return null; },
    corruptRecord: async (id: string, patch: Partial<QueueItem>) => { const record = (await q.get(id))!.value; await q.options.store.put(q.collection,{...record,...patch}); return null; },
    start: async (input: StartInput, commandKey: string) => {const result=await q.start(input,{key:commandKey}); return {...result,item:result.item.value};},
    listFiltered: async (filter: QueueListOptions) => (await q.list(filter)).map(j=>j.value),
    corruptActiveSlot: async (queue: string, activeKey: string, id: string) => {await q.options.store.set('mirk-queue-active:'+JSON.stringify([q.collection,queue,activeKey]),id); return null;},
    seedLegacy: async (id: string) => {const item=(await q.get(id))!.value; const {activeKey:_k,subject:_s,kind:_t,...legacy}=item;await q.options.store.put(q.collection,{...legacy,schemaVersion:1});return null;},
    runClaimNoop: async (id: string) => runClaim(q,claim(id),{leaseMs:20,renewEveryMs:5,commandKey:key().key,clock:{...systemClock,now:q.options.now ?? Date.now}},async()=> 'work-done'),
    get: async (id: string) => (await q.get(id))?.value ?? null,
    list: async (queue: string) => (await q.list({queue})).map(j => j.value),
    claim: async (id: string, leaseMs: number) => { const value = await q.claim(id,{...key(),leaseMs}); if(value) claims.set(value.itemId,value); return value; },
    claimNext: async (queue: string, leaseMs: number) => { const value = await q.claimNext(queue,{...key(),leaseMs}); if(value) claims.set(value.itemId,value); return value; },
    renew: async (id: string, leaseMs: number) => (await q.renew(claim(id),leaseMs,key())).value,
    checkpoint: async (id: string, value: JsonValue) => (await q.checkpoint(claim(id),value,key())).value,
    complete: async (id: string, value: JsonValue) => (await q.complete(claim(id),value,key())).value,
    fail: async (id: string, value: JsonValue) => (await q.fail(claim(id),value,key())).value,
    retry: async (id: string, availableAt: number) => (await q.retry(claim(id),availableAt,key())).value,
    block: async (id: string, value: JsonValue) => (await q.block(claim(id),value,key())).value,
    requestCancel: async (id: string) => (await q.requestCancel(id,key())).value,
    acknowledgeCancel: async (id: string) => (await q.acknowledgeCancel(claim(id),key())).value,
    recoverExpired: async (id: string) => (await q.recoverExpired(id,claim(id).generation,key())).value,
    resolveBlockedCommand: async (id: string, decision: BlockedDecision, commandKey: string) => (await q.resolveBlocked(id,(await q.get(id))!.version,decision,{key:commandKey})).value,
    resolveBlocked: async (id: string, decision: BlockedDecision) => (await q.resolveBlocked(id,(await q.get(id))!.version,decision,key())).value,
    updateQueued: async (id: string, patch: {priority?: number; availableAt?: number}) => (await q.updateQueued(id,(await q.get(id))!.version,patch,key())).value,
    requeueTerminal: async (id: string, patch: {availableAt?: number}) => (await q.requeueTerminal(id,(await q.get(id))!.version,patch,key())).value,
    removeTerminal: async (id: string) => q.removeTerminal(id,(await q.get(id))!.version,key()),
  };
}
