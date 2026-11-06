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
    it("runs the named text/image journey on one transactional connection",()=>{
      const native=sqliteVecEngine();
      let resultRows=0;
      const engine={...native,search(connection: Parameters<typeof native.search>[0],request:Parameters<typeof native.search>[1]) {
        const proxy=Object.create(connection) as typeof connection;
        proxy.prepare=(sql:string)=>{
          const statement=connection.prepare(sql);
          return {...statement,all(...params:unknown[]) {
            const rows=statement.all(...params);
            for(const row of rows) expect(Object.keys(row as object).sort()).toEqual(["id","metadata","score"]);
            resultRows+=rows.length;
            return rows;
          }};
        };
        return native.search(proxy,request);
      }};
      const db=new Adapter({path:":memory:",vectorEngine:engine});
      try {
        db.vector.ensureSpace("text",{dimensions:3});
        db.vector.ensureSpace("image",{dimensions:2});
        db.vector.upsert("assets",{id:"asset",vectors:{text:new Float32Array([1,0,0]),image:new Float32Array([0,1])},metadata:{kind:"image"}});
        expect(db.vector.meta.engine).toBe("sqlite-vec");
        expect(db.vector.search("assets",{space:"image",vector:new Float32Array([0,1])})[0]?.id).toBe("asset");
        expect(()=>db.transaction(()=>{
          db.vector.upsert("assets",{id:"transient",vectors:{text:new Float32Array([1,0,0])}});
          expect(db.vector.search("assets",{space:"text",vector:new Float32Array([1,0,0])}).map(x=>x.id)).toEqual(["asset","transient"]);
          throw new Error("rollback");
        })).toThrow("rollback");
        expect(db.vector.has("assets","transient")).toBe(false);
        expect(db.vector.get("assets","asset")?.vectors.image).toEqual(new Float32Array([0,1]));
        db.vector.upsert("assets",{id:"asset",vectors:{text:new Float32Array([1,0,0])}});
        expect(db.vector.search("assets",{space:"image",vector:new Float32Array([0,1])})).toEqual([]);
        expect(db.vector.remove("assets","asset")).toBe(true);
        expect(resultRows).toBe(3);
      } finally {db.close();}
    });

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
