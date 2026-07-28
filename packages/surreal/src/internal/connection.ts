import { Surreal } from "surrealdb";

export interface SurrealClientLike {
  connect(endpoint: string, options?: Record<string, unknown>): Promise<unknown>;
  close(): Promise<unknown> | unknown;
  query<T = unknown>(sql: string, bindings?: Record<string, unknown>): Promise<T>;
}

export interface SurrealConnectionOptions {
  endpoint?: string;
  namespace?: string;
  database?: string;
  authentication?: Record<string, unknown>;
  client?: SurrealClientLike;
  takeOwnership?: boolean;
}

export interface SurrealConnectionQueryOptions {
  bindings?: Record<string, unknown>;
}

export class SurrealConnection {
  private closed = false;

  private constructor(
    private readonly client: SurrealClientLike,
    private readonly ownsClient: boolean,
  ) {}

  static async open(options: SurrealConnectionOptions): Promise<SurrealConnection> {
    const ownsClient = options.client === undefined || options.takeOwnership === true;
    const client = options.client ?? new Surreal();
    const endpoint = options.endpoint;

    if (endpoint !== undefined) {
      await client.connect(endpoint, buildConnectOptions(options));
    }

    return new SurrealConnection(client, ownsClient);
  }

  async query<T = unknown>(
    sql: string,
    bindings?: Record<string, unknown>,
  ): Promise<T> {
    if (this.closed) throw new Error("SurrealConnection is closed.");
    return this.client.query<T>(sql, bindings);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.ownsClient) await this.client.close();
  }
}

function buildConnectOptions(options: SurrealConnectionOptions): Record<string, unknown> {
  const connectOptions: Record<string, unknown> = {};
  if (options.namespace !== undefined) connectOptions.namespace = options.namespace;
  if (options.database !== undefined) connectOptions.database = options.database;
  if (options.authentication !== undefined) connectOptions.authentication = options.authentication;
  return connectOptions;
}
