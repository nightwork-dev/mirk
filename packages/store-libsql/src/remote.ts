// Engine-free remote entry point for @mirk/store-libsql. Importing this module
// reaches @libsql/client/web only; local SQLite engine code is never loaded.

import { createClient } from "@libsql/client/web";
import {
  LibsqlAdapterCore,
  openLibsqlAdapter,
  type LibsqlClient,
  type LibsqlAdapterOptions,
} from "./libsql-core.js";

export {
  LibsqlAdapterError,
  type LibsqlAdapterErrorCode,
  type LibsqlAdapterOptions,
} from "./libsql-core.js";

function assertRemoteUrl(opts: LibsqlAdapterOptions): void {
  let protocol: string;
  try {
    protocol = new URL(opts.url).protocol.toLowerCase();
  } catch {
    throw new TypeError(remoteUrlMessage());
  }
  if (!["libsql:", "https:", "http:", "wss:", "ws:"].includes(protocol)) {
    throw new TypeError(remoteUrlMessage());
  }
}

function remoteUrlMessage(): string {
  return "@mirk/store-libsql/remote only accepts remote libSQL URLs (libsql://, https://, http://, wss://, or ws://). "
    + "Use @mirk/store-libsql for file: or :memory: storage.";
}

/** Engine-free remote libSQL source adapter. The public API matches the Node
 * entry point, but local file: and :memory: URLs are rejected before a client
 * is created. */
export class LibsqlAdapter extends LibsqlAdapterCore {
  private constructor(client: LibsqlClient, ownsClient: boolean, opts: LibsqlAdapterOptions) {
    super(client, ownsClient, opts);
  }

  static async open(opts: LibsqlAdapterOptions): Promise<LibsqlAdapter> {
    assertRemoteUrl(opts);
    return openLibsqlAdapter(
      opts,
      createClient,
      (client, ownsClient, options) => new LibsqlAdapter(client, ownsClient, options),
    );
  }
}

