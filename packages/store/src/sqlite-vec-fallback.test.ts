import { describe, expect, it } from "vitest";
import { SqliteAdapter } from "./adapters/sqlite.js";
import { NodeSqliteAdapter } from "./adapters/node-sqlite.js";
import { sqliteVecEngine, SqliteVecError } from "./sqlite-vec.js";

for (const Adapter of [SqliteAdapter, NodeSqliteAdapter]) {
  describe(`${Adapter.name} native selection`, () => {
    it("selects the ordinary exact path independently for each connection", () => {
      const native = sqliteVecEngine();
      let opens = 0;
      const selected = {...native, initialize(db: Parameters<typeof native.initialize>[0]) {
        return ++opens === 1 ? false as const : native.initialize(db);
      }};
      const ordinary = new Adapter({path:":memory:",vectorEngine:selected});
      const accelerated = new Adapter({path:":memory:",vectorEngine:selected});
      try {
        for (const db of [ordinary, accelerated]) {
          db.vector.ensureSpace("text",{dimensions:3});
          db.vector.upsertMany("docs",[
            {id:"near",vectors:{text:new Float32Array([1,.0001,0])}},
            {id:"perfect",vectors:{text:new Float32Array([1,0,0])}},
          ]);
          expect(db.vector.search("docs",{space:"text",vector:new Float32Array([1,0,0])},{minScore:1}).map(hit=>hit.id)).toEqual(["perfect"]);
        }
        expect(ordinary.vector.meta).toMatchObject({engine:"javascript",accelerated:false});
        expect(accelerated.vector.meta).toMatchObject({engine:"sqlite-vec",accelerated:true});
      } finally {ordinary.close();accelerated.close();}
    });
    it("does not downgrade a broken native query", () => {
      const db = new Adapter({path:":memory:",vectorEngine:{...sqliteVecEngine(),search(){throw new SqliteVecError("injected native query failure");}}});
      try {
        db.vector.ensureSpace("text",{dimensions:1});
        expect(()=>db.vector.search("docs",{space:"text",vector:new Float32Array([1])})).toThrow(SqliteVecError);
        expect(db.vector.meta.accelerated).toBe(true);
      } finally {db.close();}
    });
  });
}
