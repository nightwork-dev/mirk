import { DatabaseSync } from 'node:sqlite';
import { describe,expect,it,vi } from 'vitest';
import { InMemoryKv,toAsync } from '@mirk/store/kv';
import { InMemoryLogStore } from '@mirk/store/log';
import { createMemoryTransactions } from '@mirk/store/transaction';
import { NodeSqliteAdapter } from '@mirk/store/node-sqlite';
import { buildWhereClause } from '@mirk/store/sql';
import { JobsStore } from '../src/index.js';

function domain(backend:string) {
  const raw = new DatabaseSync(':memory:'); const db = new NodeSqliteAdapter({path:':memory:',db:raw});
  const kv = new InMemoryKv(); const tx = createMemoryTransactions({kv,log:new InMemoryLogStore()});
  let now=100; let ids=0;
  const store = backend === 'memory' ? toAsync(kv) : db.asyncKv;
  const transactions = backend === 'memory' ? tx : {transaction:<T>(w:()=>T|Promise<T>)=>db.asyncTransaction(w),afterCommit:(n:()=>void)=>db.afterCommit(n)};
  const jobs = new JobsStore({store,transactions,now:()=>now,token:()=>`generated-${++ids}`});
  return {jobs,store,raw,clock:(n:number)=>{now=n;},generated:()=>ids,close:()=>{db.close();}};
}
const input={key:'dedupe',queue:'renders',payload:{asset:17},subject:'asset/17',kind:'thumbnail'};
const slot='mirk-jobs-active:'+JSON.stringify(['mirk-jobs','renders','dedupe']);
describe.each(['memory','sqlite'])('keyed admission %s',backend=>{
  it('admits one active job, retains uncertain work, and preserves historical start replay',async()=>{
    const d=domain(backend); const {jobs}=d;
    try {
      const [first,second]=await Promise.all([jobs.start(input,{key:'first'}),jobs.start({...input,payload:'other'},{key:'second'})]);
      expect([first.started,second.started]).toEqual([true,false]);expect(second.job.value.id).toBe(first.job.value.id);expect(d.generated()).toBe(1);
      const claim=(await jobs.claim(first.job.value.id,{key:'claim',leaseMs:10}))!;
      await jobs.requestCancel(claim.jobId,{key:'cancel'});expect((await jobs.start(input,{key:'pending'})).started).toBe(false);
      d.clock(110);const blocked=await jobs.recoverExpired(claim.jobId,claim.generation,{key:'recover'});
      expect((await jobs.start(input,{key:'blocked'})).job.value.state).toBe('blocked');
      await jobs.resolveBlocked(claim.jobId,blocked.version,{state:'cancelled'},{key:'resolve'});
      const next=await jobs.start(input,{key:'next'});expect(next.started).toBe(true);expect(next.job.value.id).not.toBe(claim.jobId);
      expect(await jobs.start(input,{key:'first'})).toEqual(first);
      const old=(await jobs.get(claim.jobId))!;
      await expect(jobs.requeueTerminal(old.value.id,old.version,{}, {key:'conflicting-requeue'})).rejects.toMatchObject({code:'conflict'});
      expect(await d.store.get(slot)).toBe(next.job.value.id);
    }finally{d.close();}
  });
  it('releases every terminal path and repairs missing or terminal pointers without scans',async()=>{
    const d=domain(backend);const {jobs}=d;
    try {
      for(const route of ['complete','fail','acknowledgeCancel','queuedCancel','blockedCancel','resolveSuccess','resolveFail','resolveCancel']) {
        const started=await jobs.start({...input,id:route},{key:`start-${route}`});
        if(route==='queuedCancel') await jobs.requestCancel(route,{key:`end-${route}`});
        else {
          const claim=(await jobs.claim(route,{key:`claim-${route}`,leaseMs:100}))!;
          if(route==='complete') await jobs.complete(claim,null,{key:`end-${route}`});
          else if(route==='fail') await jobs.fail(claim,null,{key:`end-${route}`});
          else if(route==='acknowledgeCancel') {await jobs.requestCancel(route,{key:`cancel-${route}`});await jobs.acknowledgeCancel(claim,{key:`end-${route}`});}
          else {const blocked=await jobs.block(claim,null,{key:`block-${route}`}); if(route==='blockedCancel') await jobs.requestCancel(route,{key:`end-${route}`});else await jobs.resolveBlocked(route,blocked.version,route==='resolveSuccess'?{state:'succeeded',result:null}:route==='resolveFail'?{state:'failed',error:null}:{state:'cancelled'},{key:`end-${route}`});}
        }
        expect(started.started).toBe(true);expect(await d.store.get(slot)).toBeNull();
      }
      const spy=vi.spyOn(d.store,'list');
      await d.store.set(slot,'missing-job');const repaired=await jobs.start(input,{key:'repair-missing'});expect(repaired.started).toBe(true);
      await jobs.requestCancel(repaired.job.value.id,{key:'cancel-repaired'});await d.store.set(slot,repaired.job.value.id);
      expect((await jobs.start(input,{key:'repair-terminal'})).started).toBe(true);expect(spy).not.toHaveBeenCalled();
    }finally{d.close();}
  });
  it('delegates indexed filters, recency, limits and insertion ties; upgrades legacy records on mutation',async()=>{
    const d=domain(backend);const {jobs}=d;
    try {
      await jobs.enqueue({id:'z',queue:'q',payload:null,subject:'one',kind:'render'},{key:'z'});
      d.clock(101);await jobs.enqueue({id:'b',queue:'q',payload:null,subject:'one',kind:'render'},{key:'b'});
      await jobs.enqueue({id:'a',queue:'q',payload:null,subject:'one',kind:'render'},{key:'a'});
      await jobs.enqueue({id:'other',queue:'q',payload:null,subject:'two',kind:'render'},{key:'other'});
      const spy=vi.spyOn(d.store,'list');
      const result=await jobs.list({subject:'one',kind:'render',state:'queued',limit:2});expect(result.map(j=>j.value.id)).toEqual(['b','a']);
      expect(spy).toHaveBeenCalledWith(jobs.collection,{where:{subject:'one',kind:'render',state:'queued'},sortBy:'updatedAt',sortDir:'desc',limit:2});
      if(backend==='sqlite') {
        const table=d.raw.prepare("SELECT table_name FROM _mirk_tables WHERE name=?").get(jobs.collection) as {table_name:string};
        const where=buildWhereClause({where:{subject:'one',kind:'render',state:'queued'}});
        const plan=d.raw.prepare(`EXPLAIN QUERY PLAN SELECT data FROM ${table.table_name}${where.clause} ORDER BY json_extract(data, '$."updatedAt"') DESC NULLS LAST,rowid LIMIT 2`).all(...where.params);
        expect(plan.some(row=>String(row.detail).includes('USING INDEX'))).toBe(true);
      }
      const original=(await jobs.get('z'))!;const {activeKey:_k,subject:_s,kind:_t,...legacy}=original.value;
      await d.store.put(jobs.collection,{...legacy,schemaVersion:1});const before=await d.store.getVersioned({kind:'record',collection:jobs.collection,id:'z'});
      expect((await jobs.get('z'))!.value).toMatchObject({schemaVersion:2,activeKey:null,subject:null,kind:null});
      expect(await d.store.getVersioned({kind:'record',collection:jobs.collection,id:'z'})).toEqual(before);
      await jobs.claim('z',{key:'legacy-claim',leaseMs:10});expect((await d.store.getById<{schemaVersion:number}>(jobs.collection,'z'))!.schemaVersion).toBe(2);
    }finally{d.close();}
  });
});
