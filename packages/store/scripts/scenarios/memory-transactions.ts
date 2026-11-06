import { defineScenario } from "../../src/conformance/define.js";

export const scenarios = [
  defineScenario({
    id: "memory-transaction/lease-rollback",
    title:
      "Explicitly enlisted memory leases roll back with KV and log while fencing escaped handles",
    ports: ["memory_transaction"],
    steps: [
      { op: "memoryTransactionRollback", args: [], expect: { value: true } },
    ],
  }),
];
