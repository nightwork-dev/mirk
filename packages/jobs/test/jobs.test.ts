import { afterEach, describe, expect, it } from 'vitest';
import { NodeSqliteAdapter } from '@mirk/store/node-sqlite';
import { InMemoryLogStore, toAsyncLog } from '@mirk/store/log';
import { InMemoryKv, toAsync } from '@mirk/store/kv';
import { createMemoryTransactions } from '@mirk/store/transaction';
import type { JsonValue } from '@mirk/store/atomic';
import { JobsStore } from '../src/index.js';

const handles: NodeSqliteAdapter[] = [];
afterEach(() => { for (const h of handles.splice(0)) h.close(); });
function createSetup(backend: string) {
  const db = new NodeSqliteAdapter({path: ':memory:', versionIdentity: 'conformance'}); handles.push(db);
  let now = 100; let tokens = 0;
  const kv = new InMemoryKv({ versionIdentity: 'conformance' });
  const log = new InMemoryLogStore();
  const tx = createMemoryTransactions({kv,log});
  const transactions = backend === 'memory' ? tx : {transaction: <T>(w: () => T | Promise<T>) => db.asyncTransaction(w), afterCommit: (n: () => void) => db.afterCommit(n)};
  const jobs = new JobsStore({store: backend === 'memory' ? toAsync(kv) : db.asyncKv, transactions, log: backend === 'memory' ? toAsyncLog(log) : db.asyncLog, deleteHistoryOnRemove:true, now: () => now, token: () => `owner-${++tokens}`});
  return {db,jobs,transactions,clock: (n:number) => {now=n;}};
}
const input = {id:'job',queue:'test',payload:{input:'x'}};
describe.each(['memory','sqlite'])('durable jobs %s', backend => {
  const setup = () => createSetup(backend);
  it('keeps claims stable through renew/checkpoint and terminal command replay after cleanup', async () => {
    const {jobs,clock} = setup(); const first = await jobs.enqueue(input,{key:'enqueue'});
    clock(101); expect(await jobs.enqueue(input,{key:'enqueue'})).toEqual(first);
    await expect(jobs.enqueue({...input,payload:'other'},{key:'enqueue'})).rejects.toMatchObject({code:'idempotency-conflict'});
    const claim = (await jobs.claim('job',{leaseMs:10,key:'claim'}))!;
    await jobs.renew(claim,20,{key:'renew'}); await jobs.checkpoint(claim,{providerId:'p'},{key:'checkpoint'});
    const done = await jobs.complete(claim,'ok',{key:'complete'}); expect(done.value.state).toBe('succeeded');
    await jobs.removeTerminal('job',done.version,{key:'remove'}); expect(await jobs.get('job')).toBeNull();
    expect(await jobs.complete(claim,'ok',{key:'complete'})).toEqual(done);
    expect(await jobs.enqueue(input,{key:'enqueue'})).toEqual(first); expect(await jobs.get('job')).toBeNull();
    await expect(jobs.claim('job',{leaseMs:10,key:'claim'})).rejects.toMatchObject({code:'not-found'});
  });
  it('serializes concurrent claims, rejects stale completion, preserves uncertainty/cancellation', async () => {
    const {jobs,clock} = setup(); await jobs.enqueue(input,{key:'e'});
    const claims = await Promise.all([jobs.claim('job',{leaseMs:10,key:'c1'}),jobs.claim('job',{leaseMs:10,key:'c2'})]);
    expect(claims.filter(Boolean)).toHaveLength(1); const claim = claims.find(Boolean)!;
    await jobs.checkpoint(claim,{providerId:'remote'},{key:'p'}); await jobs.requestCancel('job',{key:'cancel'});
    await expect(jobs.complete(claim,'late',{key:'late'})).rejects.toMatchObject({code:'cancel-requested'});
    clock(110); await expect(jobs.complete(claim,'late',{key:'late'})).rejects.toMatchObject({code:'stale-claim'});
    const blocked = await jobs.recoverExpired('job',claim.generation,{key:'recover'});
    expect(blocked.value).toMatchObject({state:'blocked',checkpoint:{providerId:'remote'},cancellation:{generation:1}});
    await expect(jobs.resolveBlocked('job',blocked.version,{state:'queued',availableAt:110},{key:'resolve'})).rejects.toMatchObject({code:'cancel-requested'});
    const done = await jobs.resolveBlocked('job',blocked.version,{state:'cancelled'},{key:'resolve'}); expect(done.value.state).toBe('cancelled');
  });
  it('orders the whole eligible population and discovers without notifications', async () => {
    const {jobs} = setup();
    for (const [id,priority] of [['z',0],['b',3],['a',3]] as const) await jobs.enqueue({...input,id,priority},{key:`e${id}`});
    expect((await jobs.claimNext('test',{leaseMs:10,key:'c'}))!.jobId).toBe('a');
    expect((await jobs.list({state:'queued',limit:1}))[0]!.value.id).toBe('b');
  });
  it('rolls job and command outcome back with an outer application transaction', async () => {
    const {transactions,jobs} = setup();
    await expect(transactions.transaction(async () => {await jobs.enqueue(input,{key:'e'});throw new Error('rollback');})).rejects.toThrow('rollback');
    expect(await jobs.get('job')).toBeNull(); expect((await jobs.enqueue(input,{key:'e'})).value.state).toBe('queued');
  });
  it('updates queued priority and explicitly requeues terminal work with a fresh generation', async () => {
    const {jobs} = setup(); const queued = await jobs.enqueue(input,{key:'e'});
    const updated = await jobs.updateQueued('job',queued.version,{priority:9},{key:'priority'});
    expect(updated.value.priority).toBe(9);
    await expect(jobs.updateQueued('job',queued.version,{priority:8},{key:'old'})).rejects.toMatchObject({code:'conflict'});
    const claim = (await jobs.claim('job',{key:'c',leaseMs:10}))!;
    const failed = await jobs.fail(claim,'bad',{key:'f'});
    const queuedAgain = await jobs.requeueTerminal('job',failed.version,{}, {key:'requeue'});
    expect(queuedAgain.value).toMatchObject({state:'queued',generation:2,error:null,cancellation:null});
    expect(await jobs.requeueTerminal('job',failed.version,{}, {key:'requeue'})).toEqual(queuedAgain);
    const next = (await jobs.claim('job',{key:'c2',leaseMs:10}))!;
    expect(next.generation).toBe(3);
    await expect(jobs.complete(claim,'stale',{key:'stale'})).rejects.toMatchObject({code:'stale-claim'});
  });

  it('serializes cancellation against competing completion at writer admission', async () => {
    const {jobs} = setup(); await jobs.enqueue(input,{key:'e'});
    const claim = (await jobs.claim('job',{leaseMs:10,key:'c'}))!;
    const cancelled = await Promise.allSettled([jobs.requestCancel('job',{key:'cancel'}),jobs.complete(claim,'result',{key:'complete'})]);
    expect(cancelled[0]!.status).toBe('fulfilled'); expect(cancelled[1]!.status).toBe('rejected');
    expect((await jobs.get('job'))!.value.cancellation).not.toBeNull();
    const acknowledged = await jobs.acknowledgeCancel(claim,{key:'ack'});
    await jobs.requeueTerminal('job',acknowledged.version,{}, {key:'requeue'});
    const next = (await jobs.claim('job',{leaseMs:10,key:'next'}))!;
    const completed = await Promise.all([jobs.complete(next,'winner',{key:'winner'}),jobs.requestCancel('job',{key:'late-cancel'})]);
    expect(completed.map(j => j.value.state)).toEqual(['succeeded','succeeded']);
  });

  it('fences a reused ID even when the injected owner token repeats', async () => {
    const {jobs: original} = setup(); const jobs = new JobsStore({...original.options,deleteHistoryOnRemove:false,token:()=> 'repeated'});
    const first = await jobs.enqueue(input,{key:'e'});
    const stale = (await jobs.claim('job',{key:'c',leaseMs:10}))!;
    const done = await jobs.complete(stale,'done',{key:'done'});
    await jobs.removeTerminal('job',done.version,{key:'remove'});
    const replacement = await jobs.enqueue({...input,payload:'replacement'},{key:'replacement'});
    const next = (await jobs.claim('job',{key:'next',leaseMs:10}))!;
    expect(next.ownerToken).toBe(stale.ownerToken); expect(next.generation).toBeGreaterThan(stale.generation);
    await expect(jobs.complete(stale,'stale',{key:'stale'})).rejects.toMatchObject({code:'stale-claim'});
    expect(await jobs.enqueue(input,{key:'e'})).toEqual(first);
    expect((await jobs.get('job'))!.value.payload).toBe(replacement.value.payload);
    const firstHistory = await jobs.options.log!.list(JSON.stringify([jobs.collection,'job',0]));
    const nextHistory = await jobs.options.log!.list(JSON.stringify([jobs.collection,'job',stale.generation+1]));
    expect(firstHistory).toHaveLength(3); expect(nextHistory).toHaveLength(2);
    expect(nextHistory[0]!.sequence).toBe(1);
  });
  it('rejects runtime input fields and malformed stored lifecycle state', async () => {
    const {jobs} = setup();
    expect(() => jobs.enqueue({...input,state:'succeeded'} as typeof input,{key:'smuggled'})).toThrow('Malformed jobs data');
    const queued = await jobs.enqueue(input,{key:'e'});
    await jobs.options.store.put(jobs.collection,{...queued.value,state:'leased',ownerToken:null});
    await expect(jobs.get('job')).rejects.toMatchObject({code:'invalid-input'});
    await expect(jobs.claimNext('test',{key:'c',leaseMs:10})).rejects.toMatchObject({code:'invalid-input'});
  });
  it('rolls history cleanup, generation retention, and receipts back on log failure', async () => {
    const {jobs} = setup(); const log = jobs.options.log!; const stream = JSON.stringify([jobs.collection,'job',0]);
    jobs.options.log = {...log,append:async (stream: string,record: JsonValue) => {await log.append(stream,record);throw new Error('append failure');}};
    await expect(jobs.enqueue(input,{key:'e'})).rejects.toThrow('append failure');
    expect(await jobs.get('job')).toBeNull(); expect(await log.list(stream)).toEqual([]);
    jobs.options.log = log; await jobs.enqueue(input,{key:'e'});
    const claim = (await jobs.claim('job',{key:'c',leaseMs:10}))!;
    const done = await jobs.complete(claim,'ok',{key:'done'});
    const before = await log.list(stream);
    jobs.options.log = {...log,deleteStream:async stream => {await log.deleteStream(stream);throw new Error('log failure');}};
    await expect(jobs.removeTerminal('job',done.version,{key:'remove'})).rejects.toThrow('log failure');
    expect(await jobs.get('job')).toEqual(done); expect(await log.list(stream)).toEqual(before);
    jobs.options.log = log;
    expect(await jobs.removeTerminal('job',done.version,{key:'remove'})).toBe(true);
    expect(await log.list(stream)).toEqual([]);
    await jobs.enqueue({...input,payload:'new incarnation'},{key:'replacement'});
    const fresh = await log.list(JSON.stringify([jobs.collection,'job',claim.generation+1]));
    expect(fresh).toHaveLength(1); expect(fresh[0]!.sequence).toBe(1);
    expect(await log.list(stream,{after:before.at(-1)!.sequence})).toEqual([]);
  });
  it('retains a cancellation first requested after expiry for blocked reconciliation', async () => {
    const {jobs,clock} = setup(); await jobs.enqueue(input,{key:'e'});
    const claim = (await jobs.claim('job',{key:'c',leaseMs:10}))!;
    clock(110); await jobs.requestCancel('job',{key:'cancel'});
    const blocked = await jobs.recoverExpired('job',claim.generation,{key:'recover'});
    expect(blocked.value.cancellation).toEqual({requestedAt:110,generation:claim.generation});
  });

  it('captures caller intent before waiting for writer admission', async () => {
    const {jobs,transactions} = setup(); let release!:()=>void; let admitted!:()=>void;
    const gate = new Promise<void>(done => {release=done;}); const started = new Promise<void>(done => {admitted=done;});
    const held = transactions.transaction(async () => {admitted(); await gate;}); await started;
    const mutable = {...input,payload:{input:'original'}};
    const pending = jobs.enqueue(mutable,{key:'e'}); mutable.payload.input='changed';
    release(); await held;
    expect((await pending).value.payload).toEqual({input:'original'});
  });

});
