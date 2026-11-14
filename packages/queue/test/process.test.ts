import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { NodeSqliteAdapter } from '@mirk/store/node-sqlite';
import { QueueStore } from '../src/index.js';
const execute = promisify(execFile);
const root = fileURLToPath(new URL('../../..', import.meta.url));
const nodeWorker = fileURLToPath(new URL('./worker.mjs', import.meta.url));
const pythonWorker = resolve(root,'python/queue/tests/worker.py');
const python = process.env.PYTHON;
const run = async (language: 'node'|'python', path: string, action: string, id: string, key: string) => {
  const output = await execute(language === 'node' ? process.execPath : python ?? 'uv',[...(language === 'python' && !python ? ['run','--project',resolve(root,'python/queue'),'python'] : []),language === 'node' ? nodeWorker : pythonWorker,path,action,id,key], {env:{...process.env,PYTHONPATH:[resolve(root,'python/store/src'),resolve(root,'python/queue/src'),process.env.PYTHONPATH ?? ''].join(delimiter)}});
  return JSON.parse(output.stdout);
};
it('arbitrates real competing processes and continues the SQLite file in both languages', async () => {
  const dir = await mkdtemp(resolve(tmpdir(),'mirk-queue-')); const path = resolve(dir,'queue.db');
  const db = new NodeSqliteAdapter({path}); let now=100;
  const queue = new QueueStore({store:db.asyncKv,transactions:{transaction:w=>db.asyncTransaction(w),afterCommit:n=>db.afterCommit(n)},now:()=>now});
  try {
    const starts=await Promise.all([run('node',path,'start','node-item','node-start'),run('python',path,'start','python-item','python-start')]);
    expect(starts.filter(s=>s.started)).toHaveLength(1);expect(starts[0].item.value.id).toBe(starts[1].item.value.id);
    await queue.enqueue({id:'race',queue:'q',payload:null},{key:'e'});
    const claims = await Promise.all([run('node',path,'claim','race','node-claim'),run('python',path,'claim','race','python-claim')]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    const claim = claims.find(Boolean)!;
    expect((await run('python',path,'complete','race','python-complete')).state).toBe('succeeded');
    expect((await queue.get('race'))!.value).toMatchObject({state:'succeeded',result:{artifactId:'python-output'},checkpoint:{providerId:'python-provider'}});
    const firstTerminal = (await queue.get('race'))!;
    await queue.removeTerminal('race',firstTerminal.version,{key:'race-remove'});
    await run('python',path,'enqueue','race','race-replacement');
    const replacement = (await queue.claim('race',{key:'race-next',leaseMs:50}))!;
    expect(replacement.generation).toBeGreaterThan(claim.generation);
    await expect(queue.complete(claim,'stale',{key:'race-stale'})).rejects.toMatchObject({code:'stale-claim'});
    await run('python',path,'enqueue','reverse','python-enqueue');
    const reverse = (await queue.claim('reverse',{key:'reverse-claim',leaseMs:50}))!;
    await queue.complete(reverse,{artifactId:'node-output'},{key:'reverse-complete'});
    expect((await run('python',path,'get','reverse','unused')).result).toEqual({artifactId:'node-output'});
    await queue.enqueue({id:'expired',queue:'q',payload:null},{key:'expired-e'});
    const worker = spawn(process.execPath,[nodeWorker,path,'hold','expired','expired-c'],{stdio:['ignore','pipe','pipe']});
    const stale = await new Promise<{itemId:string;ownerToken:string;generation:number}>((done,fail) => {
      worker.once('error',fail); worker.stdout.once('data',data => done(JSON.parse(String(data))));
    });
    worker.kill('SIGKILL');
    await new Promise<void>(done => worker.once('exit',() => done()));
    now=150; const blocked = await queue.recoverExpired('expired',stale.generation,{key:'recover'});
    expect(blocked.value.state).toBe('blocked');
    await expect(queue.complete(stale,'stale',{key:'late'})).rejects.toMatchObject({code:'stale-claim'});
    expect(claim.generation).toBe(1);
  } finally {db.close(); await rm(dir,{recursive:true,force:true});}
},20000);
