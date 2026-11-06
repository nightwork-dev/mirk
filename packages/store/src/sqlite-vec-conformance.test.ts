import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { SqliteAdapter } from "./adapters/sqlite.js";
import { NodeSqliteAdapter } from "./adapters/node-sqlite.js";
import { sqliteVecEngine } from "./sqlite-vec.js";
import { compareExpect } from "./conformance/compare.js";
import { executeStep } from "./conformance/runner.js";
import type { Scenario } from "./conformance/format.js";

const corpus = resolve(process.env.MIRK_CONFORMANCE_DIR ?? "../../conformance", "vector");
const scenarios = readdirSync(corpus, { recursive:true }).filter(path=>String(path).endsWith(".json"))
  .map(path=>JSON.parse(readFileSync(resolve(corpus,String(path)),"utf8")) as Scenario);

for (const Adapter of [SqliteAdapter,NodeSqliteAdapter]) {
  describe(`${Adapter.name} with sqlite-vec vector corpus`,()=>{
    for(const scenario of scenarios) {
      it(scenario.id,async()=>{
        const db=new Adapter({path:":memory:",vectorEngine:sqliteVecEngine()});
        try {
          expect(db.vector.meta.accelerated).toBe(true);
          const api:Record<string,unknown>={};
          for(const method of ["ensureSpace","listSpaces","upsert","upsertMany","get","has","remove","count","search"] as const) {
            api[method]=db.vector[method].bind(db.vector);
          }
          for(const step of scenario.steps) {
            const outcome=await executeStep({kind:"vector",api},step);
            if(step.expect) expect(compareExpect(step.expect,outcome),`${scenario.id}: ${step.op}`).toBeNull();
            else expect(outcome.ok,JSON.stringify(outcome)).toBe(true);
          }
        } finally {db.close();}
      });
    }
  });
}
