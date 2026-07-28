import type {
  AsyncGraphTraversal,
  Direction,
  Edge,
  GraphTraversalOptions,
  GraphTraversalResult,
} from "@mirk/store/graph";
import type { AsyncStore, AsyncStoreInQuery, StoreFilter, StoreMeta } from "@mirk/store";

export interface SurrealGraphDefinition {
  nodeTable: string;
  relationTable: string;
}

export interface SurrealGraphOptions {
  graphs: Record<string, SurrealGraphDefinition>;
}

export interface SurrealQueryConnection {
  query<T = unknown>(sql: string, bindings?: Record<string, unknown>): Promise<T>;
}

type SurrealGraphEdges = AsyncStore & AsyncStoreInQuery & AsyncGraphTraversal;

interface GraphConfig {
  collection: string;
  nodeTable: string;
  relationTable: string;
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_RECURSIVE_DEPTH = 256;

export class SurrealGraphAdapter {
  readonly edges: SurrealGraphEdges;

  private constructor(connection: SurrealQueryConnection, graphs: Map<string, GraphConfig>) {
    this.edges = new SurrealGraphEdgeStore(connection, graphs);
  }

  static async open(
    connection: SurrealQueryConnection,
    options: SurrealGraphOptions,
  ): Promise<SurrealGraphAdapter> {
    const graphs = new Map<string, GraphConfig>();
    for (const [collection, definition] of Object.entries(options.graphs)) {
      assertIdentifier(collection, "graph collection");
      assertIdentifier(definition.nodeTable, `node table for ${collection}`);
      assertIdentifier(definition.relationTable, `relation table for ${collection}`);
      graphs.set(collection, { collection, ...definition });
      await connection.query(
        `DEFINE TABLE IF NOT EXISTS ${definition.nodeTable} SCHEMALESS;
DEFINE TABLE IF NOT EXISTS ${definition.relationTable} TYPE RELATION SCHEMALESS;`,
      );
    }
    return new SurrealGraphAdapter(connection, graphs);
  }
}

class SurrealGraphEdgeStore implements SurrealGraphEdges {
  readonly meta: StoreMeta = { backend: "surrealdb" };

  constructor(
    private readonly connection: SurrealQueryConnection,
    private readonly graphs: Map<string, GraphConfig>,
  ) {}

  async get<T>(key: string): Promise<T | null> {
    const records = await this.runRows<T>(
      "SELECT value FROM __mirk_surreal_graph_kv WHERE id = $id LIMIT 1",
      { id: key },
    );
    const record = records[0] as { value?: T } | undefined;
    return record?.value ?? null;
  }

  async set<T>(key: string, value: T): Promise<void> {
    await this.connection.query(
      "UPSERT type::record('__mirk_surreal_graph_kv', $id) CONTENT { id: $id, value: $value }",
      { id: key, value },
    );
  }

  async has(key: string): Promise<boolean> {
    return (await this.get(key)) !== null;
  }

  async delete(key: string): Promise<boolean> {
    const deleted = await this.runRows("DELETE type::record('__mirk_surreal_graph_kv', $id) RETURN BEFORE", {
      id: key,
    });
    return deleted.length > 0;
  }

  async keys(prefix?: string): Promise<string[]> {
    const rows = await this.runRows<{ id: unknown }>(
      prefix === undefined
        ? "SELECT VALUE id FROM __mirk_surreal_graph_kv ORDER BY id ASC"
        : "SELECT VALUE id FROM __mirk_surreal_graph_kv WHERE string::starts_with(id, $prefix) ORDER BY id ASC",
      { prefix },
    );
    return rows.map(String);
  }

  async list<T>(collection: string, filter?: StoreFilter): Promise<T[]> {
    const graph = this.graphFor(collection);
    if (!graph) {
      return this.listGeneric<T>(collection, filter);
    }

    const { clause, bindings } = edgeWhereClause(graph, filter);
    const order = orderClause(filter, "edge_id");
    const paging = pagingClause(filter);
    const rows = await this.runRows<RelationRecord>(
      `SELECT * FROM ${graph.relationTable}${clause}${order}${paging}`,
      bindings,
    );
    return normalizeAndSortEdges(rows, graph) as T[];
  }

  async getById<T>(collection: string, id: string): Promise<T | null> {
    const graph = this.graphFor(collection);
    if (!graph) {
      const rows = await this.runRows<T>(`SELECT * FROM type::record('${collection}', $id)`, { id });
      return rows[0] ?? null;
    }

    const rows = await this.runRows<RelationRecord>(
      `SELECT * FROM ${graph.relationTable} WHERE edge_id = $id LIMIT 1`,
      { id },
    );
    const edge = normalizeAndSortEdges(rows, graph)[0];
    return (edge as T | undefined) ?? null;
  }

  async put<T extends { id: string }>(collection: string, item: T): Promise<T> {
    const graph = this.graphFor(collection);
    if (!graph) {
      const [record] = await this.runRows<T>(
        `UPSERT type::record('${collection}', $id) CONTENT $content RETURN AFTER`,
        { id: item.id, content: item },
      );
      return record ?? item;
    }

    const edge = toEdge(item);
    const content = relationContent(edge);
    const [record] = await this.runRows<RelationRecord>(
      `DELETE ${graph.relationTable} WHERE edge_id = $edgeId;
UPSERT type::record($nodeTable, $fromId) CONTENT { id: $fromId };
UPSERT type::record($nodeTable, $toId) CONTENT { id: $toId };
LET $fromRecord = type::record($nodeTable, $fromId);
LET $toRecord = type::record($nodeTable, $toId);
RELATE $fromRecord->${graph.relationTable}:[$edgeId]->$toRecord CONTENT $content RETURN AFTER;`,
      {
        nodeTable: graph.nodeTable,
        fromId: edge.from,
        toId: edge.to,
        edgeId: edge.id,
        content,
      },
    );
    return (normalizeEdge(record, graph) ?? edge) as unknown as T;
  }

  async remove(collection: string, id: string): Promise<boolean> {
    const graph = this.graphFor(collection);
    if (!graph) {
      const deleted = await this.runRows(`DELETE type::record('${collection}', $id) RETURN BEFORE`, { id });
      return deleted.length > 0;
    }
    const deleted = await this.runRows(
      `DELETE ${graph.relationTable} WHERE edge_id = $id RETURN BEFORE`,
      { id },
    );
    return deleted.length > 0;
  }

  async count(collection: string, filter?: StoreFilter): Promise<number> {
    const rows = await this.list(collection, filter);
    return rows.length;
  }

  async listWhereIn<T>(
    collection: string,
    field: string,
    values: readonly unknown[],
    filter?: StoreFilter,
  ): Promise<T[]> {
    if (values.length === 0) return [];

    const graph = this.graphFor(collection);
    if (!graph) {
      return this.listGeneric<T>(collection, { ...filter, where: withoutField(filter?.where, field) }, {
        inField: field,
        values,
      });
    }

    const { clause, bindings } = edgeWhereClause(graph, { ...filter, where: withoutField(filter?.where, field) });
    const endpoint = field === "from" ? "in" : field === "to" ? "out" : field;
    const endpointClause =
      field === "from" || field === "to"
        ? `${clause ? " AND" : " WHERE"} ${endpoint} IN $endpointIds`
        : `${clause ? " AND" : " WHERE"} ${field} IN $values`;
    const rows = await this.runRows<RelationRecord>(
      `SELECT * FROM ${graph.relationTable}${clause}${endpointClause}${orderClause(filter, "edge_id")}${pagingClause(filter)}`,
      {
        ...bindings,
        endpointIds: values.map((value) => relationNodeId(graph, String(value))),
        values,
      },
    );
    return normalizeAndSortEdges(rows, graph) as T[];
  }

  canTraverseGraph(collection: string): boolean {
    return this.graphs.has(collection);
  }

  async traverseGraph(collection: string, options: GraphTraversalOptions): Promise<GraphTraversalResult> {
    const graph = this.graphFor(collection);
    if (!graph) {
      throw new Error(`Graph collection is not configured: ${collection}`);
    }
    if (!Number.isFinite(options.depth) || options.depth <= 0) {
      return { nodes: [], edges: [] };
    }

    const depth = Math.min(Math.floor(options.depth), MAX_RECURSIVE_DEPTH);
    const direction = options.direction ?? "out";
    const { clause, bindings } = edgeWhereClause(graph, options.edgeFilter, options.edgeTypes);
    const traversal = recursiveTraversalExpression(direction, graph, depth);
    const rows = await this.runRows<{ nodes?: unknown[]; edges?: RelationRecord[] }>(
      `LET $start = type::record($nodeTable, $startId);
LET $nodes = array::distinct(array::flatten([$start.{..${depth}+collect}(${traversal})]));
LET $edge_rows = SELECT * FROM ${graph.relationTable}${clause}${traversalEdgeClause(direction)};
RETURN { nodes: array::complement($nodes, [$start]), edges: $edge_rows };`,
      {
        ...bindings,
        nodeTable: graph.nodeTable,
        startId: options.start,
        startRid: relationNodeId(graph, options.start),
      },
    );

    const payload = rows[0] ?? {};
    return {
      nodes: normalizeNodes(payload.nodes, graph, options.start),
      edges: normalizeAndSortEdges(payload.edges ?? [], graph),
    };
  }

  private graphFor(collection: string): GraphConfig | undefined {
    assertIdentifier(collection, "collection");
    return this.graphs.get(collection);
  }

  private async listGeneric<T>(
    collection: string,
    filter?: StoreFilter,
    inQuery?: { inField: string; values: readonly unknown[] },
  ): Promise<T[]> {
    assertIdentifier(collection, "collection");
    const { clause, bindings } = genericWhereClause(filter, inQuery);
    return this.runRows<T>(`SELECT * FROM ${collection}${clause}${orderClause(filter, "id")}${pagingClause(filter)}`, bindings);
  }

  private async runRows<T>(sql: string, bindings: Record<string, unknown> = {}): Promise<T[]> {
    return unwrapRows<T>(await this.connection.query(sql, bindings));
  }
}

interface RelationRecord {
  id?: unknown;
  edge_id?: unknown;
  out?: unknown;
  in?: unknown;
  from?: unknown;
  to?: unknown;
  type?: unknown;
  [field: string]: unknown;
}

function assertIdentifier(identifier: string, label: string): void {
  if (!IDENTIFIER.test(identifier)) {
    throw new Error(`Invalid Surreal ${label}: ${identifier}`);
  }
}

function toEdge(item: { id: string } & Record<string, unknown>): Edge {
  if (typeof item.from !== "string" || typeof item.to !== "string" || typeof item.type !== "string") {
    throw new Error("Graph edge records must include string from, to, and type fields");
  }
  return item as Edge;
}

function relationContent(edge: Edge): Record<string, unknown> {
  const { id, from, to, ...rest } = edge;
  return { ...rest, edge_id: id };
}

function relationNodeId(graph: GraphConfig, nodeId: string): string {
  return `${graph.nodeTable}:${nodeId}`;
}

function normalizeEdge(record: RelationRecord | undefined, graph: GraphConfig): Edge | undefined {
  if (!record) return undefined;
  const { id: nativeId, edge_id, out, in: input, from: _from, to: _to, ...metadata } = record;
  const edgeId = edge_id ?? recordIdPart(nativeId);
  const from = recordIdPart(input ?? _from);
  const to = recordIdPart(out ?? _to);
  if (edgeId === undefined || from === undefined || to === undefined || typeof metadata.type !== "string") {
    return undefined;
  }
  return {
    ...metadata,
    id: String(edgeId),
    from: stripTable(from, graph.nodeTable),
    to: stripTable(to, graph.nodeTable),
    type: metadata.type,
  };
}

function normalizeAndSortEdges(records: readonly RelationRecord[], graph: GraphConfig): Edge[] {
  const edges: Edge[] = [];
  const seen = new Set<string>();
  for (const record of records) {
    const edge = normalizeEdge(record, graph);
    if (!edge || seen.has(edge.id)) continue;
    seen.add(edge.id);
    edges.push(edge);
  }
  return edges.sort((a, b) => compareString(a.id, b.id));
}

function normalizeNodes(nodes: readonly unknown[] | undefined, graph: GraphConfig, start: string): string[] {
  const seen = new Set<string>();
  for (const node of nodes ?? []) {
    const id = recordIdPart(node);
    if (id === undefined) continue;
    const stripped = stripTable(id, graph.nodeTable);
    if (stripped !== start) seen.add(stripped);
  }
  return [...seen].sort(compareString);
}

function recordIdPart(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "object" && "id" in value) {
    return recordIdPart((value as { id: unknown }).id);
  }
  const text = String(value);
  const match = /^([^:]+):(.+)$/.exec(text);
  return match?.[2] ?? text;
}

function stripTable(value: string, table: string): string {
  return value.startsWith(`${table}:`) ? value.slice(table.length + 1) : value;
}

function unwrapRows<T>(result: unknown): T[] {
  if (!Array.isArray(result)) return [];
  const last = result.at(-1);
  if (Array.isArray(last)) return last as T[];
  if (last && typeof last === "object" && "result" in last && Array.isArray((last as { result: unknown }).result)) {
    return (last as { result: T[] }).result;
  }
  if (last && typeof last === "object") return [last as T];
  return result as T[];
}

function edgeWhereClause(
  graph: GraphConfig,
  filter?: StoreFilter,
  edgeTypes?: readonly string[],
): { clause: string; bindings: Record<string, unknown> } {
  const parts: string[] = [];
  const bindings: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(filter?.where ?? {})) {
    if (field === "from") {
      parts.push(`in = $where_from`);
      bindings.where_from = relationNodeId(graph, String(value));
    } else if (field === "to") {
      parts.push(`out = $where_to`);
      bindings.where_to = relationNodeId(graph, String(value));
    } else if (field === "id") {
      parts.push(`edge_id = $where_id`);
      bindings.where_id = value;
    } else {
      assertIdentifier(field, "field");
      const key = `where_${field}`;
      parts.push(`${field} = $${key}`);
      bindings[key] = value;
    }
  }
  if (edgeTypes && edgeTypes.length > 0) {
    parts.push("type IN $edgeTypes");
    bindings.edgeTypes = [...edgeTypes];
  }
  return { clause: parts.length > 0 ? ` WHERE ${parts.join(" AND ")}` : "", bindings };
}

function genericWhereClause(
  filter?: StoreFilter,
  inQuery?: { inField: string; values: readonly unknown[] },
): { clause: string; bindings: Record<string, unknown> } {
  const parts: string[] = [];
  const bindings: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(filter?.where ?? {})) {
    assertIdentifier(field, "field");
    const key = `where_${field}`;
    parts.push(`${field} = $${key}`);
    bindings[key] = value;
  }
  if (inQuery) {
    assertIdentifier(inQuery.inField, "field");
    parts.push(`${inQuery.inField} IN $values`);
    bindings.values = [...inQuery.values];
  }
  return { clause: parts.length > 0 ? ` WHERE ${parts.join(" AND ")}` : "", bindings };
}

function withoutField(where: Record<string, unknown> | undefined, field: string): Record<string, unknown> | undefined {
  if (!where || !(field in where)) return where;
  const next = { ...where };
  delete next[field];
  return next;
}

function orderClause(filter: StoreFilter | undefined, fallback: string): string {
  const field = filter?.sortBy ?? fallback;
  assertIdentifier(field, "sort field");
  return ` ORDER BY ${field} ${(filter?.sortDir ?? "asc").toUpperCase() === "DESC" ? "DESC" : "ASC"}`;
}

function pagingClause(filter: StoreFilter | undefined): string {
  const limit = Number.isInteger(filter?.limit) && Number(filter?.limit) >= 0 ? ` LIMIT ${filter?.limit}` : "";
  const offset = Number.isInteger(filter?.offset) && Number(filter?.offset) >= 0 ? ` START ${filter?.offset}` : "";
  return `${limit}${offset}`;
}

function recursiveTraversalExpression(direction: Direction, graph: GraphConfig, depth: number): string {
  if (direction === "out") return `->${graph.relationTable}->(?)`;
  if (direction === "in") return `<-${graph.relationTable}<-(?)`;
  return `array::distinct(array::flatten([@.{..${depth}+collect}(->${graph.relationTable}->(?)), @.{..${depth}+collect}(<-${graph.relationTable}<-(?))]))`;
}

function traversalEdgeClause(direction: Direction): string {
  const outClause = "(in IN array::concat([$start], $nodes) AND out IN $nodes)";
  const inClause = "(out IN array::concat([$start], $nodes) AND in IN $nodes)";
  if (direction === "out") return ` AND ${outClause}`;
  if (direction === "in") return ` AND ${inClause}`;
  return ` AND (${outClause} OR ${inClause})`;
}

function compareString(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
