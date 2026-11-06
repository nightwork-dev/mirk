import { type SqliteDb } from "./sqlite-driver.js";
import { matchesWhere } from "../vector/filter.js";
import type {
  SearchStore,
  SearchDocument,
  SearchResult,
  SearchOptions,
} from "../search/types.js";
import { sanitizeFtsQuery } from "../search/tokenize.js";
import {
  DEFAULT_SEARCH_FIELD,
  assertSameSearchFields,
  assertValidFieldWeightValues,
  fieldWeightsFor,
  normalizeSearchDocument,
  type NormalizedSearchFields,
} from "../search/fields.js";
import {
  hashName,
  ftsTableFor,
  SEARCH_DOCS_TABLE_PREFIX,
  SEARCH_TABLE_KIND,
} from "../sql.js";
import { runTableResolution } from "./sqlite-registry.js";
// ─── Search facet (SearchStore) ─────────────────────────────────────────────
//
// FTS5 + bm25 over the same connection as .kv/.vector. Per collection: one
// stable field schema, a docs table {id, <field columns>, meta_json} as the FTS5
// external-content source, with triggers keeping the index in lockstep (the same
// pattern used by downstream knowledge indexes). search runs `MATCH ? ORDER BY bm25(fts,
// ...weights)`, maps bm25 (lower=better) to score=-bm25 (higher=better), and
// applies the meta `filter` in JS via matchesWhere — the identical semantics to
// the in-memory reference.

interface SearchMatchRow {
  id: string;
  meta_json: string | null;
  bm: number;
}

interface SearchSchema {
  fields: string[];
  columns: string[];
}

function searchColumnName(field: string, index: number): string {
  if (field === DEFAULT_SEARCH_FIELD) return DEFAULT_SEARCH_FIELD;
  return `f${index}_${hashName(field)}`;
}

function searchSchema(fields: readonly string[]): SearchSchema {
  return { fields: [...fields], columns: fields.map(searchColumnName) };
}

function quoteSqlIdent(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

function searchFieldDefs(schema: SearchSchema): string {
  return schema.columns
    .map((column) => `${quoteSqlIdent(column)} TEXT NOT NULL`)
    .join(",\n        ");
}

function rowColumnRefs(prefix: "new" | "old", schema: SearchSchema): string {
  return schema.columns
    .map((column) => `${prefix}.${quoteSqlIdent(column)}`)
    .join(", ");
}

export class SqliteSearchFacet implements SearchStore {
  private readonly ensured = new Set<string>();
  private readonly resolvedTables = new Map<string, string>();
  private readonly schemaTable = "_mirk_search_schema";

  constructor(private readonly db: SqliteDb) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ${this.schemaTable} (
        collection TEXT PRIMARY KEY,
        fields_json TEXT NOT NULL
      );
    `);
  }

  /** Physical docs table for a collection, via the `_mirk_tables` registry
   *  under kind `search`. `register` false is for read paths: they answer the
   *  same question without writing a registry row for a collection that may
   *  never have been indexed. */
  private baseTable(collection: string, register: boolean): string {
    const cached = this.resolvedTables.get(collection);
    if (cached !== undefined) return cached;
    const table = runTableResolution(
      this.db,
      SEARCH_TABLE_KIND,
      collection,
      SEARCH_DOCS_TABLE_PREFIX,
      register,
    );
    if (register && !this.db.inTransaction)
      this.resolvedTables.set(collection, table);
    return table;
  }

  /** One registry row governs both tables: the FTS name is derived from the
   *  resolved docs name, and the triggers are named from the docs name below. */
  private ftsTable(docsTable: string): string {
    return ftsTableFor(docsTable);
  }

  private tableExists(table: string): boolean {
    return (
      this.db
        .prepare(
          "SELECT 1 AS ok FROM sqlite_master WHERE type IN ('table', 'view') AND name = ?",
        )
        .get(table) !== undefined
    );
  }

  private loadSchema(collection: string): SearchSchema | undefined {
    const row = this.db
      .prepare(
        `SELECT fields_json FROM ${this.schemaTable} WHERE collection = ?`,
      )
      .get(collection) as { fields_json: string } | undefined;
    if (row) {
      const fields = JSON.parse(row.fields_json) as string[];
      return searchSchema(fields);
    }

    // Upgrade path for databases created by the earlier single-column search
    // facet: the collection tables already exist, but there is no schema row.
    // Treat them as the default `{ text }` schema and persist that fact.
    const docs = this.baseTable(collection, false);
    if (!this.tableExists(docs)) return undefined;
    const pragma = this.db
      .prepare(`PRAGMA table_info(${quoteSqlIdent(docs)})`)
      .all() as Array<{ name: string }>;
    if (!pragma.some((col) => col.name === DEFAULT_SEARCH_FIELD))
      return undefined;
    const fields = [DEFAULT_SEARCH_FIELD];
    this.db
      .prepare(
        `INSERT OR IGNORE INTO ${this.schemaTable}(collection, fields_json) VALUES (?, ?)`,
      )
      .run(collection, JSON.stringify(fields));
    return searchSchema(fields);
  }

  private schemaForIndex(
    collection: string,
    normalized: NormalizedSearchFields,
  ): SearchSchema {
    const existing = this.loadSchema(collection);
    if (existing) {
      assertSameSearchFields(existing.fields, normalized.names, collection);
      return existing;
    }
    const fields = [...normalized.names];
    this.db
      .prepare(
        `INSERT INTO ${this.schemaTable}(collection, fields_json) VALUES (?, ?)`,
      )
      .run(collection, JSON.stringify(fields));
    return searchSchema(fields);
  }

  private ensure(
    collection: string,
    schema: SearchSchema,
  ): { docs: string; fts: string } {
    const docs = this.baseTable(collection, true);
    const fts = this.ftsTable(docs);
    const key = `${docs}:${schema.fields.join("\u0000")}`;
    if (this.ensured.has(key)) return { docs, fts };

    const qDocs = quoteSqlIdent(docs);
    const qFts = quoteSqlIdent(fts);
    const qColumns = schema.columns.map(quoteSqlIdent).join(", ");
    const newColumns = rowColumnRefs("new", schema);
    const oldColumns = rowColumnRefs("old", schema);
    const fieldDefs = searchFieldDefs(schema);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ${qDocs} (
        id TEXT PRIMARY KEY,
        ${fieldDefs},
        meta_json TEXT
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS ${qFts} USING fts5(
        ${qColumns}, content='${docs}', content_rowid='rowid', tokenize='unicode61'
      );
      CREATE TRIGGER IF NOT EXISTS ${quoteSqlIdent(
        `${docs}_ai`,
      )} AFTER INSERT ON ${qDocs} BEGIN
        INSERT INTO ${qFts}(rowid, ${qColumns}) VALUES (new.rowid, ${newColumns});
      END;
      CREATE TRIGGER IF NOT EXISTS ${quoteSqlIdent(
        `${docs}_ad`,
      )} AFTER DELETE ON ${qDocs} BEGIN
        INSERT INTO ${qFts}(${quoteSqlIdent(
          fts,
        )}, rowid, ${qColumns}) VALUES('delete', old.rowid, ${oldColumns});
      END;
      CREATE TRIGGER IF NOT EXISTS ${quoteSqlIdent(
        `${docs}_au`,
      )} AFTER UPDATE ON ${qDocs} BEGIN
        INSERT INTO ${qFts}(${quoteSqlIdent(
          fts,
        )}, rowid, ${qColumns}) VALUES('delete', old.rowid, ${oldColumns});
        INSERT INTO ${qFts}(rowid, ${qColumns}) VALUES (new.rowid, ${newColumns});
      END;
    `);
    this.ensured.add(key);
    return { docs, fts };
  }

  index<M extends Record<string, unknown> = Record<string, unknown>>(
    collection: string,
    doc: SearchDocument<M>,
  ): void {
    const normalized = normalizeSearchDocument(doc);
    const schema = this.schemaForIndex(collection, normalized);
    const { docs } = this.ensure(collection, schema);
    const qDocs = quoteSqlIdent(docs);
    const qColumns = schema.columns.map(quoteSqlIdent);
    const insertColumns = ["id", ...schema.columns, "meta_json"]
      .map(quoteSqlIdent)
      .join(", ");
    const placeholders = Array.from(
      { length: schema.columns.length + 2 },
      () => "?",
    ).join(", ");
    const updateSet = [
      ...qColumns.map((col) => `${col} = excluded.${col}`),
      "meta_json = excluded.meta_json",
    ].join(", ");
    const metaJson = doc.meta === undefined ? null : JSON.stringify(doc.meta);
    this.db
      .prepare(
        `INSERT INTO ${qDocs}(${insertColumns}) VALUES (${placeholders})
         ON CONFLICT(id) DO UPDATE SET ${updateSet}`,
      )
      .run(
        doc.id,
        ...schema.fields.map((field) => normalized.values[field] ?? ""),
        metaJson,
      );
  }

  indexMany<M extends Record<string, unknown> = Record<string, unknown>>(
    collection: string,
    docs: ReadonlyArray<SearchDocument<M>>,
  ): void {
    const tx = this.db.transaction(
      (items: ReadonlyArray<SearchDocument<M>>) => {
        for (const doc of items) this.index(collection, doc);
      },
    );
    tx(docs);
  }

  remove(collection: string, id: string): boolean {
    const schema = this.loadSchema(collection);
    if (!schema) return false;
    const { docs } = this.ensure(collection, schema);
    return (
      this.db.prepare(`DELETE FROM ${quoteSqlIdent(docs)} WHERE id = ?`).run(id)
        .changes > 0
    );
  }

  search<M extends Record<string, unknown> = Record<string, unknown>>(
    collection: string,
    query: string,
    opts?: SearchOptions,
  ): SearchResult<M>[] {
    const sanitized = sanitizeFtsQuery(query);
    assertValidFieldWeightValues(opts?.fieldWeights);
    if (sanitized.length === 0) return [];
    const schema = this.loadSchema(collection);
    if (!schema) return [];
    const { docs, fts } = this.ensure(collection, schema);
    const weights = fieldWeightsFor(schema.fields, opts?.fieldWeights);
    const weightArgs =
      weights.length > 0
        ? `, ${weights.map((weight) => String(weight)).join(", ")}`
        : "";
    // Fetch ALL matches ordered by bm25 (lower=better), then apply the meta
    // filter in JS (matching the in-memory reference) and limit — so filter is
    // applied before limit, consistent with /vector's pre-KNN filtering.
    const rows = this.db
      .prepare(
        `SELECT d.id AS id, d.meta_json AS meta_json, bm25(${fts}${weightArgs}) AS bm
         FROM ${quoteSqlIdent(fts)}
         JOIN ${quoteSqlIdent(docs)} d ON d.rowid = ${fts}.rowid
         WHERE ${fts} MATCH ?
         ORDER BY bm, d.id`,
      )
      .all(sanitized) as SearchMatchRow[];
    const limit = opts?.limit ?? 10;
    const where = opts?.filter?.where;
    const out: SearchResult<M>[] = [];
    for (const r of rows) {
      const meta = (r.meta_json === null ? {} : JSON.parse(r.meta_json)) as M;
      if (where && !matchesWhere(meta, where)) continue;
      out.push({ id: r.id, score: -r.bm, meta });
    }
    return out.slice(0, limit);
  }
}

// SQL building (jsonPath / buildWhereClause / buildOrderBy / buildLimitOffset /
// hashName) and the `_mirk_tables` physical-name resolution procedure live in
// ../sql.ts — shared verbatim with @mirk/store-libsql so the two SQLite-dialect
// adapters can't drift in filter semantics or in table naming. See that module.
