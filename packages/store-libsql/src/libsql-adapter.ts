// Node entry point for @mirk/store-libsql. The shared adapter core is driver
// agnostic; this wrapper binds it to @libsql/client's Node implementation,
// retaining local file: and :memory: support as well as remote libSQL URLs.

import { createClient } from "@libsql/client";
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

/** Node/libSQL source adapter. Use `@mirk/store-libsql/remote` when the
 *  engine-free web client is preferred and only remote URLs are allowed. */
export class LibsqlAdapter extends LibsqlAdapterCore {
  private constructor(client: LibsqlClient, ownsClient: boolean, opts: LibsqlAdapterOptions) {
    super(client, ownsClient, opts);
  }

  static open(opts: LibsqlAdapterOptions): Promise<LibsqlAdapter> {
    return openLibsqlAdapter(
      opts,
      createClient,
      (client, ownsClient, options) => new LibsqlAdapter(client, ownsClient, options),
    );
  }
}

