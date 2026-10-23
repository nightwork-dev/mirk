import { afterAll, beforeAll, describe } from "vitest";

import { asyncTransactionContract } from "../../../store/src/conformance/transaction-contract.js";
import {
  dropTables,
  fileTarget,
  runPrefix,
  sqldBinary,
  sqldTarget,
  startSqld,
  tursoConnection,
  tursoTarget,
  type Sqld,
  type Target,
} from "./targets.js";

function contract(target: Target): void {
  asyncTransactionContract(`libSQL ${target.name} (two adapters, two clients, one database)`, {
    async open() {
      const database = await target.fresh();
      const first = await database.open();
      const second = await database.open();
      return { first, second, close: () => database.dispose() };
    },
  });
}

describe("local file", { timeout: 30_000 }, () => contract(fileTarget()));

describe.runIf(sqldBinary)("sqld", { timeout: 60_000 }, () => {
  let server: Sqld;
  beforeAll(async () => {
    server = await startSqld(sqldBinary!);
  });
  afterAll(async () => {
    await server?.stop();
  });
  contract(sqldTarget(() => server));
});

describe.runIf(tursoConnection)("Turso", { timeout: 120_000 }, () => {
  afterAll(async () => {
    await dropTables(tursoConnection!, runPrefix);
  });
  contract(tursoTarget());
});
