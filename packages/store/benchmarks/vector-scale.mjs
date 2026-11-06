import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { cpus, platform, release, totalmem } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { NodeSqliteAdapter } from "@mirk/store/node-sqlite";
import { sqliteVecEngine } from "@mirk/store/sqlite-vec";

const args = Object.fromEntries(process.argv.slice(2).map(arg => {
  const [key, ...value] = arg.replace(/^--/, "").split("=");
  return [key, value.join("=")];
}));
const vector = (seed, dimensions) => {
  let state = seed >>> 0;
  const out = new Float32Array(dimensions);
  for (let i = 0; i < dimensions; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    out[i] = state / 2 ** 31 - 1;
  }
  return out;
};
const memory = () => ({...process.memoryUsage(), maxRssKiB:process.resourceUsage().maxRSS});
const distribution = samples => {
  const values = [...samples].sort((a,b)=>a-b);
  const at = fraction => values[Math.min(values.length-1,Math.ceil(values.length*fraction)-1)];
  return {samples:values.length,p50:at(.5),p95:at(.95),max:values.at(-1)};
};

async function worker(config) {
  const start = performance.now();
  const open = () => new NodeSqliteAdapter({path:config.path,...(config.engine === "native" ? {vectorEngine:sqliteVecEngine()} : {})});
  let db = open();
  const meta = db.vector.meta;
  if (config.engine === "native" && !meta.accelerated) throw Error("Native companion unavailable; refusing to label ordinary scoring native");
  const initializationMs = performance.now()-start;
  const samples = [];
  const results = [];
  try {
    for (let iteration = 0; iteration <= config.repeats; iteration++) {
      for (let index = 0; index < config.queries; index++) {
        for (const filtered of [false,true]) {
          let connectionInitializationMs=initializationMs;
          if(iteration===0 && (index>0 || filtered)) {
            db.close();const opened=performance.now();db=open();void db.vector.meta;
            connectionInitializationMs=performance.now()-opened;
          }
          global.gc?.();
          const before = memory(), cpu = process.cpuUsage();
          let timerDelayMs;
          const started = performance.now();
          const timer = new Promise(resolveTimer=>setTimeout(()=>{
            timerDelayMs=performance.now()-started;resolveTimer();
          },0));
          const hits = db.vector.search("synthetic",{space:"text",vector:vector(0xf00d+index,config.dimensions)},
            {topK:config.topK,...(filtered?{where:{group:0}}:{})});
          const elapsedMs = performance.now()-started;
          const after = memory(), consumed = process.cpuUsage(cpu);
          await timer;
          samples.push({iteration,index,filtered,phase:iteration===0?"cold-connection":"warm",connectionInitializationMs,elapsedMs,timerDelayMs,
            cpuMs:(consumed.user+consumed.system)/1000,before,after});
          if (iteration===0) results.push({index,filtered,hits});
          else if(JSON.stringify(hits)!==JSON.stringify(results[index*2+Number(filtered)].hits)) throw Error("Results changed between repeats");
        }
      }
    }
    return {meta,initializationMs,samples,results};
  } finally {db.close();}
}

if (args.worker) {
  writeFileSync(args["worker-output"],JSON.stringify(await worker(JSON.parse(args.worker))));
} else {
  const counts = (args.counts ?? "1000,10000,100000").split(",").map(Number);
  const dimensions=Number(args.dimensions??768), repeats=Number(args.repeats??7), queries=Number(args.queries??3);
  const batchSize=Number(args.batch??256),topK=Number(args.topK??10);
  if (![...counts,dimensions,repeats,queries,batchSize,topK].every(n=>Number.isSafeInteger(n)&&n>0)) throw Error("Counts, dimensions, repeats, queries, batch and topK must be positive integers");
  const directory=resolve(args.directory??`/tmp/mirk-vector-scale-${Date.now()}`);
  mkdirSync(directory,{recursive:true});
  const raw = new DatabaseSync(":memory:");
  const sqliteVersion=raw.prepare("SELECT sqlite_version() version").get().version;raw.close();
  const report={dataset:"synthetic seeded float32 signed vectors; group=id modulo 10",coldMeaning:"fresh connection for every cold sample; OS file cache is uncontrolled; cold-connection is not disk-cold",hardware:{platform:platform(),os:release(),arch:process.arch,cpu:cpus()[0]?.model,logicalCpus:cpus().length,totalMemoryBytes:totalmem()},runtime:{node:process.version,sqlite:sqliteVersion,mirkStore:JSON.parse(readFileSync(new URL("../package.json",import.meta.url),"utf8")).version},configuration:{counts,dimensions,repeats,queries,batchSize,topK},cases:[]};
  for(const count of counts) {
    const path=join(directory,`vectors-${count}-${dimensions}.db`);
    if(existsSync(path)) throw Error(`Dataset file already exists: ${path}; choose a fresh directory`);
    const db=new NodeSqliteAdapter({path});
    db.vector.ensureSpace("text",{dimensions});
    const before=memory(),cpu=process.cpuUsage(),start=performance.now();
    for(let offset=0;offset<count;offset+=batchSize) {
      const batch=[];
      for(let id=offset;id<Math.min(offset+batchSize,count);id++) batch.push({id:String(id).padStart(12,"0"),vectors:{text:vector(id+1,dimensions)},metadata:{group:id%10}});
      db.vector.upsertMany("synthetic",batch);
    }
    db.checkpoint("truncate");db.close();
    const consumed=process.cpuUsage(cpu);
    const ingestion={elapsedMs:performance.now()-start,cpuMs:(consumed.user+consumed.system)/1000,fileBytes:statSync(path).size,before,after:memory()};
    const engines={};
    for(const engine of ["javascript","native"]) {
      const workerOutput=join(directory,`${count}-${engine}.json`);
      const child=spawnSync(process.execPath,["--expose-gc",fileURLToPath(import.meta.url),`--worker=${JSON.stringify({path,engine,dimensions,repeats,queries,topK})}`,`--worker-output=${workerOutput}`],{encoding:"utf8"});
      if(child.status!==0) throw Error(`${engine} benchmark failed: ${child.stderr}`);
      engines[engine]=JSON.parse(readFileSync(workerOutput,"utf8"));
    }
    if(JSON.stringify(engines.javascript.results)!==JSON.stringify(engines.native.results)) throw Error(`Exact native/ordinary result mismatch at ${count} vectors`);
    for(const engine of Object.values(engines)) {
      engine.latency={};
      for(const phase of ["cold-connection","warm"]) for(const filtered of [false,true]) {
        const selected=engine.samples.filter(s=>s.phase===phase&&s.filtered===filtered);
        engine.latency[`${phase}-${filtered?"filtered":"all"}`]=distribution(selected.map(s=>s.elapsedMs));
      }
      engine.exampleBudgetsMs=Object.fromEntries([16.7,100,1000].map(budget=>[budget,engine.samples.filter(s=>s.elapsedMs>budget).length]));
    }
    report.cases.push({count,path,ingestion,exactResultsMatch:true,engines});
    writeFileSync(args.output??join(directory,"results.json"),JSON.stringify(report,null,2));
    console.error(`${count}x${dimensions}: exact results match; JS/native warm unfiltered p50 ${engines.javascript.latency["warm-all"].p50.toFixed(2)}/${engines.native.latency["warm-all"].p50.toFixed(2)}ms`);
  }
  console.log(JSON.stringify(report,null,2));
}
