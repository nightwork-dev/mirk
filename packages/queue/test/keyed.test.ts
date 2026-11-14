import { DatabaseSync } from 'node:sqlite';
import { describe,expect,it,vi } from 'vitest';
import { InMemoryKv,toAsync } from '@mirk/store/kv';
import { InMemoryLogStore } from '@mirk/store/log';
import { createMemoryTransactions } from '@mirk/store/transaction';
import { NodeSqliteAdapter } from '@mirk/store/node-sqlite';
import { buildWhereClause } from '@mirk/store/sql';
import { QueueStore } from '../src/index.js';

function domain(backend:string) {
  const raw = new DatabaseSync(':memory:'); const db = new NodeSqliteAdapter({path:':memory:',db:raw});
  const kv = new InMemoryKv(); const tx = createMemoryTransactions({kv,log:new InMemoryLogStore()});
  let now=100; let ids=0;
  const store = backend === 'memory' ? toAsync(kv) : db.asyncKv;
  const transactions = backend === 'memory' ? tx : {transaction:<T>(w:()=>T|Promise<T>)=>db.asyncTransaction(w),afterCommit:(n:()=>void)=>db.afterCommit(n)};
  const queue = new QueueStore({store,transactions,now:()=>now,token:()=>`generated-${++ids}`});
  return {queue,store,raw,clock:(n:number)=>{now=n;},generated:()=>ids,close:()=>{db.close();}};
}
const input={key:'dedupe',queue:'renders',payload:{asset:17},subject:'asset/17',kind:'thumbnail'};
const slot='mirk-queue-active:'+JSON.stringify(['mirk-queue','renders','dedupe']);
describe.each(['memory','sqlite'])('keyed admission %s',backend=>{
  it('admits one active item, retains uncertain work, and preserves historical start replay',async()=>{
    const d=domain(backend); const {queue}=d;
    try {
      const [first,second]=await Promise.all([queue.start(input,{key:'first'}),queue.start({...input,payload:'other'},{key:'second'})]);
      expect([first.started,second.started]).toEqual([true,false]);expect(second.item.value.id).toBe(first.item.value.id);expect(d.generated()).toBe(1);
      const claim=(await queue.claim(first.item.value.id,{key:'claim',leaseMs:10}))!;
      await queue.requestCancel(claim.itemId,{key:'cancel'});expect((await queue.start(input,{key:'pending'})).started).toBe(false);
      d.clock(110);const blocked=await queue.recoverExpired(claim.itemId,claim.generation,{key:'recover'});
      expect((await queue.start(input,{key:'blocked'})).item.value.state).toBe('blocked');
      await queue.resolveBlocked(claim.itemId,blocked.version,{state:'cancelled'},{key:'resolve'});
      const next=await queue.start(input,{key:'next'});expect(next.started).toBe(true);expect(next.item.value.id).not.toBe(claim.itemId);
      expect(await queue.start(input,{key:'first'})).toEqual(first);
      const old=(await queue.get(claim.itemId))!;
      await expect(queue.requeueTerminal(old.value.id,old.version,{}, {key:'conflicting-requeue'})).rejects.toMatchObject({code:'conflict'});
      expect(await d.store.get(slot)).toBe(next.item.value.id);
    }finally{d.close();}
  });
  it('releases every terminal path and repairs missing or terminal pointers without scans',async()=>{
    const d=domain(backend);const {queue}=d;
    try {
      for(const route of ['complete','fail','acknowledgeCancel','queuedCancel','blockedCancel','resolveSuccess','resolveFail','resolveCancel']) {
        const started=await queue.start({...input,id:route},{key:`start-${route}`});
        if(route==='queuedCancel') await queue.requestCancel(route,{key:`end-${route}`});
        else {
          const claim=(await queue.claim(route,{key:`claim-${route}`,leaseMs:100}))!;
          if(route==='complete') await queue.complete(claim,null,{key:`end-${route}`});
          else if(route==='fail') await queue.fail(claim,null,{key:`end-${route}`});
          else if(route==='acknowledgeCancel') {await queue.requestCancel(route,{key:`cancel-${route}`});await queue.acknowledgeCancel(claim,{key:`end-${route}`});}
          else {const blocked=await queue.block(claim,null,{key:`block-${route}`}); if(route==='blockedCancel') await queue.requestCancel(route,{key:`end-${route}`});else await queue.resolveBlocked(route,blocked.version,route==='resolveSuccess'?{state:'succeeded',result:null}:route==='resolveFail'?{state:'failed',error:null}:{state:'cancelled'},{key:`end-${route}`});}
        }
        expect(started.started).toBe(true);expect(await d.store.get(slot)).toBeNull();
      }
      const spy=vi.spyOn(d.store,'list');
      await d.store.set(slot,'missing-item');const repaired=await queue.start(input,{key:'repair-missing'});expect(repaired.started).toBe(true);
      await queue.requestCancel(repaired.item.value.id,{key:'cancel-repaired'});await d.store.set(slot,repaired.item.value.id);
      expect((await queue.start(input,{key:'repair-terminal'})).started).toBe(true);expect(spy).not.toHaveBeenCalled();
    }finally{d.close();}
  });
  it('delegates indexed filters, recency, limits and insertion ties; upgrades legacy records on mutation',async()=>{
    const d=domain(backend);const {queue}=d;
    try {
      await queue.enqueue({id:'z',queue:'q',payload:null,subject:'one',kind:'render'},{key:'z'});
      d.clock(101);await queue.enqueue({id:'b',queue:'q',payload:null,subject:'one',kind:'render'},{key:'b'});
      await queue.enqueue({id:'a',queue:'q',payload:null,subject:'one',kind:'render'},{key:'a'});
      await queue.enqueue({id:'other',queue:'q',payload:null,subject:'two',kind:'render'},{key:'other'});
      const spy=vi.spyOn(d.store,'list');
      const result=await queue.list({subject:'one',kind:'render',state:'queued',limit:2});expect(result.map(j=>j.value.id)).toEqual(['b','a']);
      expect(spy).toHaveBeenCalledWith(queue.collection,{where:{subject:'one',kind:'render',state:'queued'},sortBy:'updatedAt',sortDir:'desc',limit:2});
      if(backend==='sqlite') {
        const table=d.raw.prepare("SELECT table_name FROM _mirk_tables WHERE name=?").get(queue.collection) as {table_name:string};
        const where=buildWhereClause({where:{subject:'one',kind:'render',state:'queued'}});
        const plan=d.raw.prepare(`EXPLAIN QUERY PLAN SELECT data FROM ${table.table_name}${where.clause} ORDER BY json_extract(data, '$."updatedAt"') DESC NULLS LAST,rowid LIMIT 2`).all(...where.params);
        expect(plan.some(row=>String(row.detail).includes('USING INDEX'))).toBe(true);
      }
      const original=(await queue.get('z'))!;const {activeKey:_k,subject:_s,kind:_t,...legacy}=original.value;
      await d.store.put(queue.collection,{...legacy,schemaVersion:1});const before=await d.store.getVersioned({kind:'record',collection:queue.collection,id:'z'});
      expect((await queue.get('z'))!.value).toMatchObject({schemaVersion:2,activeKey:null,subject:null,kind:null});
      expect(await d.store.getVersioned({kind:'record',collection:queue.collection,id:'z'})).toEqual(before);
      await queue.claim('z',{key:'legacy-claim',leaseMs:10});expect((await d.store.getById<{schemaVersion:number}>(queue.collection,'z'))!.schemaVersion).toBe(2);
    }finally{d.close();}
  });
});
