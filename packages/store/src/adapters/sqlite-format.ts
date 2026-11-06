import { MIRK_REGISTRY_DDL, MIRK_SCHEMA_VERSION, VECTOR_FORMAT_DDL } from '../sql.js';
import type { SqliteDb } from './sqlite-driver.js';



type Failure = (code:'unsupported-schema-version'|'malformed-schema'|'migration-required', message:string)=>Error;
export function ensureMirkFormat(db:SqliteDb, failure:Failure):void {
 const exists=(name:string)=>!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
 const version=():number|null=>{
   if(!exists('_mirk_meta'))return null;
   const rows=db.prepare("SELECT value FROM _mirk_meta WHERE key='schema_version'").all() as {value:unknown}[];
   if(rows.length!==1||typeof rows[0]!.value!=='string'||! /^(0|[1-9][0-9]*)$/.test(rows[0]!.value))throw failure('malformed-schema','Malformed Mirk schema version');
   const value=Number(rows[0]!.value);
   if(!Number.isSafeInteger(value)||value<1)throw failure('malformed-schema','Malformed Mirk schema version');
   if(value>MIRK_SCHEMA_VERSION)throw failure('unsupported-schema-version',`Mirk SQLite file schema version ${value} is newer than this adapter understands (${MIRK_SCHEMA_VERSION}).`);
   return value;
 };
 version();
 db.transaction(()=>{
   const found=version();
   if(found===MIRK_SCHEMA_VERSION){
     for(const table of ['_mirk_tables','_mirk_vector_spaces','_mirk_vector_documents','_mirk_vector_values'])if(!exists(table))throw failure('malformed-schema',`Missing Mirk table ${table}`);
     return;
   }
   const tables=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as {name:string}[];
   if(found===null&&tables.some(row=>row.name.startsWith('_mirk_'))&&!exists('_mirk_tables'))throw failure('malformed-schema','Unrecognized unversioned Mirk layout');
   if(found!==null&&found!==1&&found!==2)throw failure('malformed-schema','Unsupported legacy Mirk format');
   let dimensions:number|undefined;
   if(exists('_vec_meta')){
     const row=db.prepare("SELECT value FROM _vec_meta WHERE key='dimensions'").get() as {value:string}|undefined;
     if(row){dimensions=Number(row.value);if(!Number.isSafeInteger(dimensions)||dimensions<=0)throw failure('malformed-schema','Invalid legacy vector dimensions');}
   }
   if(exists('vectors')){
     const columns=db.prepare('PRAGMA table_info(vectors)').all() as {name:string}[];
     if(!['collection','id','vec','metadata'].every(name=>columns.some(col=>col.name===name)))throw failure('malformed-schema','Unrecognized legacy vectors layout');
     const lengths=db.prepare('SELECT DISTINCT length(vec) AS n, typeof(vec) AS kind FROM vectors').all() as {n:number;kind:string}[];
     if(lengths.some(row=>row.kind!=='blob'||row.n<=0||row.n%4!==0))throw failure('malformed-schema','Invalid legacy vector BLOB');
     if(dimensions===undefined&&lengths.length)dimensions=lengths[0]!.n/4;
     if(lengths.some(row=>row.n!==dimensions!*4))throw failure('malformed-schema','Legacy vector dimensions do not match BLOB lengths');
   }
   db.exec(MIRK_REGISTRY_DDL);
   db.exec(VECTOR_FORMAT_DDL);
   if(dimensions!==undefined)db.prepare("INSERT INTO _mirk_vector_spaces VALUES('default','default',?,'cosine','float32')").run(dimensions);
   if(exists('vectors')){
     db.exec("INSERT INTO _mirk_vector_documents(namespace,collection,id,metadata) SELECT 'default',collection,id,metadata FROM vectors");
     db.exec("INSERT INTO _mirk_vector_values(namespace,collection,id,space,vec) SELECT 'default',collection,id,'default',vec FROM vectors");
     db.exec('DROP TABLE vectors');
   }
   if(exists('_vec_meta'))db.exec('DROP TABLE _vec_meta');
   db.prepare("INSERT INTO _mirk_meta(key,value) VALUES('schema_version',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(MIRK_SCHEMA_VERSION));
 }).immediate();
}
