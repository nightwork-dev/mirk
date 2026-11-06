import { NodeSqliteAdapter } from '@mirk/store/node-sqlite';
import { JobsStore } from '../dist/index.js';
const [path, action, id, key] = process.argv.slice(2);
const db = new NodeSqliteAdapter({path});
const jobs = new JobsStore({store:db.asyncKv,transactions:{transaction:w=>db.asyncTransaction(w),afterCommit:n=>db.afterCommit(n)},now:()=>100});
try {
  const result = action === 'start' ? await jobs.start({id,queue:'q',key:'shared',payload:null},{key}) : ['claim','hold'].includes(action) ? await jobs.claim(id,{key,leaseMs:50}) : (await jobs.get(id))?.value;
  process.stdout.write(JSON.stringify(result) + '\n');
  if (action === 'hold') await new Promise(() => {setInterval(() => {},1000);});
} finally {db.close();}
