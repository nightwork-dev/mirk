import { DatabaseSync } from 'node:sqlite';

const db = new DatabaseSync(process.argv[2], { readOnly: true });
try {
  const rows = sql => db.prepare(sql).all();
  const tables = new Set(rows("SELECT name FROM sqlite_master WHERE type='table'").map(row => row.name));
  let version = null;
  if (tables.has('_mirk_meta')) {
    const markers = rows("SELECT value FROM _mirk_meta WHERE key='schema_version'");
    if (markers.length !== 1 || !['2', '3', '4'].includes(markers[0].value)) throw Error('Unsupported or malformed core format');
    version = Number(markers[0].value);
  }
  const registry = tables.has('_mirk_tables') ? rows('SELECT * FROM _mirk_tables ORDER BY kind,name') : [];
  const collection = registry.find(row => row.kind === 'collection' && row.name === 'items')?.table_name ?? [...tables].find(name => name.startsWith('c_items_'));
  const docs = registry.find(row => row.kind === 'search' && row.name === 'notes')?.table_name ?? [...tables].find(name => name.startsWith('search_docs_notes_'));
  const fts = docs.replace('search_docs_', 'search_fts_');
  const raw = rows("SELECT value FROM _kv WHERE key='unicode'")[0].value;
  const named = version === 3 || version === 4;
  const vectors = rows(named ? 'SELECT namespace,collection,id,space,lower(hex(vec)) AS hex FROM _mirk_vector_values ORDER BY namespace,collection,id,space' : "SELECT 'default' AS namespace,collection,id,'default' AS space,lower(hex(vec)) AS hex FROM vectors ORDER BY collection,id");
  const spaces = named ? rows('SELECT * FROM _mirk_vector_spaces ORDER BY namespace,name') : [{ namespace: 'default', name: 'default', dimensions: Number(rows("SELECT value FROM _vec_meta WHERE key='dimensions'")[0].value), metric: 'cosine', encoding: 'float32' }];
  const vectorMetadata = rows(`SELECT ${named ? "namespace" : "'default'"} AS namespace,collection,id,metadata FROM ${named ? '_mirk_vector_documents' : 'vectors'} ORDER BY namespace,collection,id`);
  const receipts = rows('SELECT * FROM _mirk_atomic_receipts ORDER BY idempotency_key').map(row => ({ ...row, created_at: row.created_at ?? null, result_json: JSON.parse(row.result_json) }));
  console.log(JSON.stringify({
    version, unicode: JSON.parse(raw), unicodeRawHex: Buffer.from(raw).toString('hex'), registry,
    kvRows: rows("SELECT * FROM _kv ORDER BY key").map(row => ({ ...row, value: JSON.parse(row.value) })),
    collectionRows: rows(`SELECT data FROM ${collection} ORDER BY rowid`).map(row => JSON.parse(row.data)),
    spaces, vectors, vectorMetadata,
    logs: tables.has('_mirk_log') ? rows('SELECT * FROM _mirk_log ORDER BY stream,sequence') : [],
    logStreams: tables.has('_mirk_log_streams') ? rows('SELECT * FROM _mirk_log_streams ORDER BY stream') : [],
    logGeneration: tables.has('_mirk_log_generation') ? rows('SELECT * FROM _mirk_log_generation') : [],
    atomicIdentity: rows('SELECT value FROM _mirk_atomic_identity WHERE id=1')[0].value,
    atomicSequence: rows('SELECT value FROM _mirk_atomic_sequence WHERE id=1')[0].value,
    versions: rows('SELECT * FROM _mirk_atomic_versions ORDER BY kind,collection,target_key'), receipts,
    hasReceiptTime: rows('PRAGMA table_info(_mirk_atomic_receipts)').some(row => row.name === 'created_at'),
    searchDocuments: rows(`SELECT * FROM ${docs} ORDER BY rowid`),
    searchMatches: rows(`SELECT d.id FROM ${fts} f JOIN ${docs} d ON d.rowid=f.rowid WHERE ${fts} MATCH 'golden' ORDER BY d.id`).map(row => row.id),
    applicationRows: rows('SELECT * FROM application_owned ORDER BY id'),
    declaredIndexes: rows("SELECT name,sql FROM sqlite_master WHERE type='index' AND name LIKE 'ix_%' ORDER BY name"),
  }));
} finally { db.close(); }
