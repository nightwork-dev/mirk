function names(prefix: string) {
  if (!/^[A-Za-z0-9_]*$/.test(prefix)) throw new TypeError("Invalid SQLite table prefix");
  return { log: `${prefix}_mirk_log`, streams: `${prefix}_mirk_log_streams`, counter: `${prefix}_mirk_log_generation` };
}
function ddl(prefix: string): string {
  const { log, streams, counter } = names(prefix);
  return `CREATE TABLE IF NOT EXISTS ${log} (
    stream TEXT NOT NULL,
    sequence INTEGER NOT NULL CHECK (sequence >= 1),
    record TEXT NOT NULL,
    PRIMARY KEY (stream, sequence)
  ) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS ${counter} (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    value INTEGER NOT NULL CHECK (value >= 0 AND value <= 9007199254740991)
  );
  INSERT INTO ${counter} (id, value) VALUES (1, 0) ON CONFLICT(id) DO NOTHING;
  CREATE TABLE IF NOT EXISTS ${streams} (
    stream TEXT PRIMARY KEY,
    generation INTEGER NOT NULL UNIQUE CHECK (generation >= 1 AND generation <= 9007199254740991)
  ) WITHOUT ROWID;`;
}
export const LOG_FORMAT_DDL = ddl("");
export function logGenerationMigrationSql(tablePrefix = ""): readonly string[] {
  const { log, streams, counter } = names(tablePrefix);
  return [ddl(tablePrefix),
    `INSERT INTO ${streams} (stream, generation)
     SELECT stream, ROW_NUMBER() OVER (ORDER BY stream COLLATE BINARY)
     FROM (SELECT DISTINCT stream FROM ${log})`,
    `UPDATE ${counter} SET value = (SELECT COALESCE(MAX(generation), 0) FROM ${streams}) WHERE id = 1`,
  ];
}
