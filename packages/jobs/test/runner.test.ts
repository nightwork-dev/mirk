import { execFileSync } from 'node:child_process';
import { describe,expect,it } from 'vitest';
import type { CoordinationAbortSignal, CoordinationClock } from '@mirk/store/coordination/core';
import { InMemoryKv,toAsync } from '@mirk/store/kv';
import { InMemoryLogStore } from '@mirk/store/log';
import { createMemoryTransactions } from '@mirk/store/transaction';
import { NodeSqliteAdapter } from '@mirk/store/node-sqlite';
import { JobsStore,runClaim } from '../src/index.js';
class Clock implements CoordinationClock {
  value=100; pending=new Set<{at:number;wake:()=>void}>();
  now(){return this.value;}
  sleep(ms:number,signal?:CoordinationAbortSignal){return new Promise<void>((resolve,reject)=>{
    const item={at:this.value+ms,wake:()=>{cleanup();resolve();}};
    const abort=()=>{cleanup();reject(signal?.reason);};
    const cleanup=()=>{this.pending.delete(item);signal?.removeEventListener('abort',abort);};
    this.pending.add(item);signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  });}
  advance(value:number){this.value=value;for(const item of [...this.pending])if(item.at<=value)item.wake();}
}
async function until(test:()=>boolean|Promise<boolean>){for(let i=0;i<200;i++){if(await test())return;await Promise.resolve();}throw Error('Clock work did not settle');}
function setup(backend:string){
  const clock=new Clock();const db=new NodeSqliteAdapter({path:':memory:'});const kv=new InMemoryKv();const tx=createMemoryTransactions({kv,log:new InMemoryLogStore()});
  const jobs=new JobsStore({store:backend==='memory'?toAsync(kv):db.asyncKv,transactions:backend==='memory'?tx:{transaction:w=>db.asyncTransaction(w),afterCommit:n=>db.afterCommit(n)},now:()=>clock.now()});
  return {jobs,clock,close:()=>db.close()};
}
describe.each(['memory','sqlite'])('one claim runner %s',backend=>{
  it('renews, cooperatively aborts on cancellation, and refuses a success after abort',async()=>{
    const d=setup(backend);try{
      await d.jobs.enqueue({id:'job',queue:'q',payload:null},{key:'e'});const claim=(await d.jobs.claim('job',{key:'c',leaseMs:10}))!;
      let invoked=0;
      const result=runClaim(d.jobs,claim,{leaseMs:10,renewEveryMs:3,commandKey:'runner',clock:d.clock},async signal=>{invoked++;return new Promise<string>(done=>signal.addEventListener('abort',()=>done('ignored-abort'),{once:true}));});
      const rejected=expect(result).rejects.toMatchObject({code:'cancel-requested'});
      await until(()=>d.clock.pending.size===1);d.clock.advance(103);
      await until(async()=> (await d.jobs.get('job'))!.value.expiresAt===113);
      await d.jobs.requestCancel('job',{key:'cancel'});await until(()=>d.clock.pending.size===1);d.clock.advance(106);
      await rejected;expect(invoked).toBe(1);expect(d.clock.pending.size).toBe(0);
      expect((await d.jobs.get('job'))!.value.state).toBe('leased');
    }finally{d.close();}
  });
  it('cannot revive expiry and cleans external abort listeners and pending sleeps',async()=>{
    const d=setup(backend);try{
      await d.jobs.enqueue({id:'job',queue:'q',payload:null},{key:'e'});const claim=(await d.jobs.claim('job',{key:'c',leaseMs:10}))!;
      const external=new AbortController();let removed=0;const remove=external.signal.removeEventListener.bind(external.signal);
      external.signal.removeEventListener=(...args)=>{removed++;return remove(...args);};
      const result=runClaim(d.jobs,claim,{leaseMs:10,renewEveryMs:3,commandKey:'runner',clock:d.clock,signal:external.signal},signal=>new Promise<string>(done=>signal.addEventListener('abort',()=>done('ignored'),{once:true})));
      const rejected=expect(result).rejects.toMatchObject({code:'stale-claim'});
      await until(()=>d.clock.pending.size===1);d.clock.advance(110);await rejected;
      expect(d.clock.pending.size).toBe(0);expect(removed).toBe(1);expect((await d.jobs.get('job'))!.value.expiresAt).toBe(110);
      let calls=0;external.abort(new Error('external'));
      await expect(runClaim(d.jobs,claim,{leaseMs:10,renewEveryMs:3,commandKey:'other',clock:d.clock,signal:external.signal},async()=>{calls++;return 1;})).rejects.toThrow('external');expect(calls).toBe(0);
    }finally{d.close();}
  });
  it('checks final ownership even if no renewal timer fires and cleans up on callback errors',async()=>{
    const d=setup(backend);try{
      await d.jobs.enqueue({id:'job',queue:'q',payload:null},{key:'e'});const claim=(await d.jobs.claim('job',{key:'c',leaseMs:10}))!;
      await expect(runClaim(d.jobs,claim,{leaseMs:10,renewEveryMs:3,commandKey:'callback-error',clock:d.clock},async()=>{throw new Error('callback error');})).rejects.toThrow('callback error');expect(d.clock.pending.size).toBe(0);
      let finish!:()=>void;const gate=new Promise<void>(done=>{finish=done;});
      const result=runClaim(d.jobs,claim,{leaseMs:10,renewEveryMs:3,commandKey:'runner',clock:d.clock},async()=>{await gate;return 'done';});
      const rejected=expect(result).rejects.toMatchObject({code:'stale-claim'});
      await until(()=>d.clock.pending.size===1);await d.jobs.complete(claim,null,{key:'other-handler'});finish();await rejected;expect(d.clock.pending.size).toBe(0);
    }finally{d.close();}
  });
});

it('imports the jobs entry and runner without loading SQLite bindings',()=>{
  const entry=new URL('../dist/index.js',import.meta.url).href;
  const script=`import {registerHooks} from 'node:module';registerHooks({resolve(id,context,next){if(id==='better-sqlite3'||id==='node:sqlite')throw Error('Native binding imported');return next(id,context);}});const jobs=await import(${JSON.stringify(entry)});if(typeof jobs.runClaim!=='function')throw Error('Missing runner');`;
  expect(()=>execFileSync(process.execPath,['--input-type=module','-e',script])).not.toThrow();
});
