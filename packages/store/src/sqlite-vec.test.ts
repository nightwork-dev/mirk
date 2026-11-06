import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { NodeSqliteDriver, type NodeSqliteConnection } from "./adapters/sqlite-driver.js";
import { sqliteVecEngine, SqliteVecError } from "./sqlite-vec.js";
import { cosineSimilarity, isUsableVector, vectorToBuffer } from "./vector/cosine.js";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
  DatabaseSync: new (path: string, options: { allowExtension: boolean }) => NodeSqliteConnection;
};
function fixture() {
  const db = new NodeSqliteDriver(new DatabaseSync(":memory:", { allowExtension: true }));
  db.exec(`CREATE TABLE _mirk_vector_values(namespace,collection,id,space,vec);
    CREATE TABLE _mirk_vector_documents(namespace,collection,id,metadata);`);
  const engine = sqliteVecEngine();
  engine.initialize(db);
  const vectors = new Map<string,Float32Array>();
  const put = (id: string, values: number[], metadata?: Record<string, unknown>) => {
    const vector = new Float32Array(values);
    vectors.set(id,vector);
    db.prepare("INSERT INTO _mirk_vector_values VALUES('default','test',?,'x',?)").run(id,vectorToBuffer(vector));
    db.prepare("INSERT INTO _mirk_vector_documents VALUES('default','test',?,?)").run(id,metadata === undefined ? null : JSON.stringify(metadata));
  };
  const search = (query: Float32Array, options = {}) => engine.search(db, {namespace:"default",collection:"test",space:"x",vector:query,options});
  return {db,engine,put,search,vectors};
}

describe("sqlite-vec native ordered float64 scoring", () => {
  it("preserves inclusive cutoff, zero-query, nonfinite and extreme magnitudes", () => {
    const f=fixture();
    try {
      f.put("a-near",[1,.0001,0]); f.put("b-perfect",[1,0,0]);
      f.put("huge",[1e30,0,0]); f.put("tiny",[1e-30,0,0]);
      f.put("zero",[0,0,0]); f.put("nan",[NaN,0,0]); f.put("inf",[Infinity,0,0]);
      expect(f.search(new Float32Array([1,0,0]),{minScore:1}).map(x=>x.id)).toEqual(["b-perfect","huge","tiny"]);
      expect(f.search(new Float32Array([1,0,0]),{topK:1})[0]?.id).toBe("b-perfect");
      expect(f.search(new Float32Array(3))).toEqual(["a-near","b-perfect","huge","tiny"].map(id=>({id,score:0})));
      expect(f.search(new Float32Array([NaN,0,0]))).toEqual([]);
    } finally { f.db.close(); }
  });

  it("prefilters exact nested JSON, empty metadata and whereNot conjunctions", () => {
    const f=fixture();
    try {
      f.put("absent",[1,0]); f.put("empty",[1,0],{});
      f.put("both",[1,0],{a:1,b:2,nested:{x:[true,null]}});
      f.put("partial",[1,0],{a:1,b:3,nested:{x:[true,null]}});
      const q=new Float32Array([1,0]);
      expect(f.search(q,{where:{}}).map(x=>x.id)).toEqual(["both","empty","partial"]);
      expect(f.search(q,{whereNot:{a:1,b:2}}).map(x=>x.id)).toEqual(["absent","empty","partial"]);
      expect(f.search(q,{where:{nested:{x:[true,null]}}}).map(x=>x.id)).toEqual(["both","partial"]);
    } finally { f.db.close(); }
  });

  it("matches exact scores and membership across adversarial vector populations", () => {
    let seed=41;
    const random=()=>((seed=(Math.imul(seed,1664525)+1013904223)>>>0)/2**32)*2-1;
    for (const dimensions of [1,3,31,128]) {
      const f=fixture();
      try {
        for(let n=0;n<70;n++) {
          const scale=[1,1e-30,1e30,1e-8,1e8,2**-149,3.4028234663852886e38][n%7]!;
          f.put(String(n).padStart(3,"0"),Array.from({length:dimensions},()=>random()*scale));
        }
        for(let n=0;n<5;n++) {
          const q=new Float32Array(Array.from({length:dimensions},()=>random()));
          const expected=[...f.vectors].filter(([,v])=>isUsableVector(v)).map(([id,v])=>({id,score:cosineSimilarity(v,q)})).sort((a,b)=>b.score-a.score || (a.id<b.id?-1:1));
          for(const topK of [1,10,-1]) {
            expect(f.search(q,{topK})).toEqual(expected.slice(0,topK));
            const floor=expected[10]!.score;
            expect(f.search(q,{topK,minScore:floor})).toEqual(expected.filter(x=>x.score>=floor).slice(0,topK));
          }
        }
      } finally {f.db.close();}
    }
  });

  it("normalizes fractional and nonfinite limits like array slicing", () => {
    const f=fixture();
    try {
      for(const id of ["a","b","c"]) f.put(id,[1]);
      for(const limit of [2.5,-2.5,.5,-.5,NaN,Infinity,-Infinity]) {
        expect(f.search(new Float32Array([1]),{topK:limit}).map(hit=>hit.id))
          .toEqual(["a","b","c"].slice(0,limit));
      }
    } finally {f.db.close();}
  });

  it("surfaces initialization and execution failures without fallback", () => {
    const f=fixture();
    try {
      expect(()=>f.engine.initialize({...f.db,loadExtension(){throw new Error("broken load");}} as unknown as NodeSqliteDriver)).toThrow(SqliteVecError);
      f.db.exec("DROP TABLE _mirk_vector_values");
      expect(()=>f.search(new Float32Array([1,0]))).toThrow(SqliteVecError);
    } finally {f.db.close();}
  });
});
