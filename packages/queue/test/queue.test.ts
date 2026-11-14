import { afterEach, describe, expect, it } from 'vitest';
import { NodeSqliteAdapter } from '@mirk/store/node-sqlite';
import { InMemoryLogStore, toAsyncLog } from '@mirk/store/log';
import { InMemoryKv, toAsync } from '@mirk/store/kv';
import { createMemoryTransactions } from '@mirk/store/transaction';
import type { JsonValue } from '@mirk/store/atomic';
import type { BlockedDecision } from '../src/types.js';
import { QueueStore } from '../src/index.js';

const handles: NodeSqliteAdapter[] = [];
afterEach(() => { for (const h of handles.splice(0)) h.close(); });
function createSetup(backend: string) {
  const db = new NodeSqliteAdapter({path: ':memory:', versionIdentity: 'conformance'}); handles.push(db);
  let now = 100; let tokens = 0;
  const kv = new InMemoryKv({ versionIdentity: 'conformance' });
  const log = new InMemoryLogStore();
  const tx = createMemoryTransactions({kv,log});
  const transactions = backend === 'memory' ? tx : {transaction: <T>(w: () => T | Promise<T>) => db.asyncTransaction(w), afterCommit: (n: () => void) => db.afterCommit(n)};
  const queue = new QueueStore({store: backend === 'memory' ? toAsync(kv) : db.asyncKv, transactions, log: backend === 'memory' ? toAsyncLog(log) : db.asyncLog, deleteHistoryOnRemove:true, now: () => now, token: () => `owner-${++tokens}`});
  return {db,queue,transactions,clock: (n:number) => {now=n;}};
}
const input = {id:'item',queue:'test',payload:{input:'x'}};
describe.each(['memory','sqlite'])('durable queue %s', backend => {
  const setup = () => createSetup(backend);
  it('keeps claims stable through renew/checkpoint and terminal command replay after cleanup', async () => {
    const {queue,clock} = setup(); const first = await queue.enqueue(input,{key:'enqueue'});
    clock(101); expect(await queue.enqueue(input,{key:'enqueue'})).toEqual(first);
    await expect(queue.enqueue({...input,payload:'other'},{key:'enqueue'})).rejects.toMatchObject({code:'idempotency-conflict'});
    const claim = (await queue.claim('item',{leaseMs:10,key:'claim'}))!;
    await queue.renew(claim,20,{key:'renew'}); await queue.checkpoint(claim,{providerId:'p'},{key:'checkpoint'});
    const done = await queue.complete(claim,'ok',{key:'complete'}); expect(done.value.state).toBe('succeeded');
    await queue.removeTerminal('item',done.version,{key:'remove'}); expect(await queue.get('item')).toBeNull();
    expect(await queue.complete(claim,'ok',{key:'complete'})).toEqual(done);
    expect(await queue.enqueue(input,{key:'enqueue'})).toEqual(first); expect(await queue.get('item')).toBeNull();
    await expect(queue.claim('item',{leaseMs:10,key:'claim'})).rejects.toMatchObject({code:'not-found'});
  });
  it('serializes concurrent claims, rejects stale completion, preserves uncertainty/cancellation', async () => {
    const {queue,clock} = setup(); await queue.enqueue(input,{key:'e'});
    const claims = await Promise.all([queue.claim('item',{leaseMs:10,key:'c1'}),queue.claim('item',{leaseMs:10,key:'c2'})]);
    expect(claims.filter(Boolean)).toHaveLength(1); const claim = claims.find(Boolean)!;
    await queue.checkpoint(claim,{providerId:'remote'},{key:'p'}); await queue.requestCancel('item',{key:'cancel'});
    await expect(queue.complete(claim,'late',{key:'late'})).rejects.toMatchObject({code:'cancel-requested'});
    clock(110); await expect(queue.complete(claim,'late',{key:'late'})).rejects.toMatchObject({code:'stale-claim'});
    const blocked = await queue.recoverExpired('item',claim.generation,{key:'recover'});
    expect(blocked.value).toMatchObject({state:'blocked',checkpoint:{providerId:'remote'},cancellation:{generation:1}});
    await expect(queue.resolveBlocked('item',blocked.version,{state:'queued',availableAt:110},{key:'resolve'})).rejects.toMatchObject({code:'cancel-requested'});
    const done = await queue.resolveBlocked('item',blocked.version,{state:'cancelled'},{key:'resolve'}); expect(done.value.state).toBe('cancelled');
  });
  it('orders the whole eligible population and discovers without notifications', async () => {
    const {queue} = setup();
    for (const [id,priority] of [['z',0],['b',3],['a',3]] as const) await queue.enqueue({...input,id,priority},{key:`e${id}`});
    expect((await queue.claimNext('test',{leaseMs:10,key:'c'}))!.itemId).toBe('a');
    expect((await queue.list({state:'queued',sortBy:'priority',limit:1}))[0]!.value.id).toBe('b');
  });
  it('rolls item and command outcome back with an outer application transaction', async () => {
    const {transactions,queue} = setup();
    await expect(transactions.transaction(async () => {await queue.enqueue(input,{key:'e'});throw new Error('rollback');})).rejects.toThrow('rollback');
    expect(await queue.get('item')).toBeNull(); expect((await queue.enqueue(input,{key:'e'})).value.state).toBe('queued');
  });
  it('updates queued priority and explicitly requeues terminal work with a fresh generation', async () => {
    const {queue} = setup(); const queued = await queue.enqueue(input,{key:'e'});
    const updated = await queue.updateQueued('item',queued.version,{priority:9},{key:'priority'});
    expect(updated.value.priority).toBe(9);
    await expect(queue.updateQueued('item',queued.version,{priority:8},{key:'old'})).rejects.toMatchObject({code:'conflict'});
    const claim = (await queue.claim('item',{key:'c',leaseMs:10}))!;
    const failed = await queue.fail(claim,'bad',{key:'f'});
    const queuedAgain = await queue.requeueTerminal('item',failed.version,{}, {key:'requeue'});
    expect(queuedAgain.value).toMatchObject({state:'queued',generation:2,error:null,cancellation:null});
    expect(await queue.requeueTerminal('item',failed.version,{}, {key:'requeue'})).toEqual(queuedAgain);
    const next = (await queue.claim('item',{key:'c2',leaseMs:10}))!;
    expect(next.generation).toBe(3);
    await expect(queue.complete(claim,'stale',{key:'stale'})).rejects.toMatchObject({code:'stale-claim'});
  });

  it('serializes cancellation against competing completion at writer admission', async () => {
    const {queue} = setup(); await queue.enqueue(input,{key:'e'});
    const claim = (await queue.claim('item',{leaseMs:10,key:'c'}))!;
    const cancelled = await Promise.allSettled([queue.requestCancel('item',{key:'cancel'}),queue.complete(claim,'result',{key:'complete'})]);
    expect(cancelled[0]!.status).toBe('fulfilled'); expect(cancelled[1]!.status).toBe('rejected');
    expect((await queue.get('item'))!.value.cancellation).not.toBeNull();
    const acknowledged = await queue.acknowledgeCancel(claim,{key:'ack'});
    await queue.requeueTerminal('item',acknowledged.version,{}, {key:'requeue'});
    const next = (await queue.claim('item',{leaseMs:10,key:'next'}))!;
    const completed = await Promise.all([queue.complete(next,'winner',{key:'winner'}),queue.requestCancel('item',{key:'late-cancel'})]);
    expect(completed.map(j => j.value.state)).toEqual(['succeeded','succeeded']);
  });

  it('fences a reused ID even when the injected owner token repeats', async () => {
    const {queue: original} = setup(); const queue = new QueueStore({...original.options,deleteHistoryOnRemove:false,token:()=> 'repeated'});
    const first = await queue.enqueue(input,{key:'e'});
    const stale = (await queue.claim('item',{key:'c',leaseMs:10}))!;
    const done = await queue.complete(stale,'done',{key:'done'});
    await queue.removeTerminal('item',done.version,{key:'remove'});
    const replacement = await queue.enqueue({...input,payload:'replacement'},{key:'replacement'});
    const next = (await queue.claim('item',{key:'next',leaseMs:10}))!;
    expect(next.ownerToken).toBe(stale.ownerToken); expect(next.generation).toBeGreaterThan(stale.generation);
    await expect(queue.complete(stale,'stale',{key:'stale'})).rejects.toMatchObject({code:'stale-claim'});
    expect(await queue.enqueue(input,{key:'e'})).toEqual(first);
    expect((await queue.get('item'))!.value.payload).toBe(replacement.value.payload);
    const firstHistory = await queue.options.log!.list(JSON.stringify([queue.collection,'item',0]));
    const nextHistory = await queue.options.log!.list(JSON.stringify([queue.collection,'item',stale.generation+1]));
    expect(firstHistory).toHaveLength(3); expect(nextHistory).toHaveLength(2);
    expect(nextHistory[0]!.sequence).toBe(1);
  });
  it('rejects runtime input fields and malformed stored lifecycle state', async () => {
    const {queue} = setup();
    expect(() => queue.enqueue({...input,state:'succeeded'} as typeof input,{key:'smuggled'})).toThrow('Malformed queue data');
    const queued = await queue.enqueue(input,{key:'e'});
    await queue.options.store.put(queue.collection,{...queued.value,state:'leased',ownerToken:null});
    await expect(queue.get('item')).rejects.toMatchObject({code:'invalid-input'});
    await expect(queue.claimNext('test',{key:'c',leaseMs:10})).rejects.toMatchObject({code:'invalid-input'});
  });
  it('rolls history cleanup, generation retention, and receipts back on log failure', async () => {
    const {queue} = setup(); const log = queue.options.log!; const stream = JSON.stringify([queue.collection,'item',0]);
    queue.options.log = {...log,append:async (stream: string,record: JsonValue) => {await log.append(stream,record);throw new Error('append failure');}};
    await expect(queue.enqueue(input,{key:'e'})).rejects.toThrow('append failure');
    expect(await queue.get('item')).toBeNull(); expect(await log.list(stream)).toEqual([]);
    queue.options.log = log; await queue.enqueue(input,{key:'e'});
    const claim = (await queue.claim('item',{key:'c',leaseMs:10}))!;
    const done = await queue.complete(claim,'ok',{key:'done'});
    const before = await log.list(stream);
    queue.options.log = {...log,deleteStream:async stream => {await log.deleteStream(stream);throw new Error('log failure');}};
    await expect(queue.removeTerminal('item',done.version,{key:'remove'})).rejects.toThrow('log failure');
    expect(await queue.get('item')).toEqual(done); expect(await log.list(stream)).toEqual(before);
    queue.options.log = log;
    expect(await queue.removeTerminal('item',done.version,{key:'remove'})).toBe(true);
    expect(await log.list(stream)).toEqual([]);
    await queue.enqueue({...input,payload:'new incarnation'},{key:'replacement'});
    const fresh = await log.list(JSON.stringify([queue.collection,'item',claim.generation+1]));
    expect(fresh).toHaveLength(1); expect(fresh[0]!.sequence).toBe(1);
    await expect(log.list(stream,{after:{generation:before.at(-1)!.generation,sequence:before.at(-1)!.sequence}})).rejects.toMatchObject({code:'stale-cursor'});
  });
  it('retains a cancellation first requested after expiry for blocked reconciliation', async () => {
    const {queue,clock} = setup(); await queue.enqueue(input,{key:'e'});
    const claim = (await queue.claim('item',{key:'c',leaseMs:10}))!;
    clock(110); await queue.requestCancel('item',{key:'cancel'});
    const blocked = await queue.recoverExpired('item',claim.generation,{key:'recover'});
    expect(blocked.value.cancellation).toEqual({requestedAt:110,generation:claim.generation});
  });

  it('captures caller intent before waiting for writer admission', async () => {
    const {queue,transactions} = setup(); let release!:()=>void; let admitted!:()=>void;
    const gate = new Promise<void>(done => {release=done;}); const started = new Promise<void>(done => {admitted=done;});
    const held = transactions.transaction(async () => {admitted(); await gate;}); await started;
    const mutable = {...input,payload:{input:'original'}};
    const pending = queue.enqueue(mutable,{key:'e'}); mutable.payload.input='changed';
    release(); await held;
    expect((await pending).value.payload).toEqual({input:'original'});
  });

  it('validates malformed blocked decisions before looking up a used command key', async () => {
    const {queue} = setup(); await queue.enqueue(input,{key:'e'});
    const claim = (await queue.claim('item',{key:'c',leaseMs:10}))!;
    const blocked = await queue.block(claim,null,{key:'block'});
    const decision = {state:'cancelled'} as const;
    const resolved = await queue.resolveBlocked('item',blocked.version,decision,{key:'resolve'});
    expect(await queue.resolveBlocked('item',blocked.version,decision,{key:'resolve'})).toEqual(resolved);
    for (const malformed of [{state:'cancelled',result:'unexpected'},{}]) {
      expect(() => queue.resolveBlocked('item',blocked.version,malformed as BlockedDecision,{key:'resolve'})).toThrowError(expect.objectContaining({code:'invalid-input'}));
    }
    expect(await queue.get('item')).toEqual(resolved);
  });

});
