// ─── Scenarios: append-only log ─────────────────────────────────────────────
// The log port's contract: per-stream sequences that start at 1 and have no
// gaps among committed appends, reads by sequence and after a sequence, JSON
// record fidelity, and the rollback rule. `appendRolledBack(stream, record)`
// is a target op, not a port method: it appends inside the backend's own
// transaction, rolls that transaction back, and returns the sequence the
// append was given.

import { defineScenario } from "../../src/conformance/define.js";

const FIVE = ["a", "b", "c", "d", "e"].map((step) => ({
  op: "append",
  args: ["s", { step }],
}));

export const scenarios = [
  defineScenario({
    id: "log/sequence-starts-at-one-and-increases",
    title: "the first append to a stream gets 1 and each later append gets the next integer",
    ports: ["log"],
    steps: [
      { op: "lastSequence", args: ["s"], expect: { value: true } },
      { op: "append", args: ["s", "first"], expect: { value: true } },
      { op: "append", args: ["s", "second"], expect: { value: true } },
      { op: "append", args: ["s", "third"], expect: { value: true } },
      { op: "lastSequence", args: ["s"], expect: { value: true } },
      { op: "list", args: ["s"], expect: { value: true } },
    ],
  }),

  defineScenario({
    id: "log/streams-are-independent",
    title: "each stream numbers its own appends, and reads see only their stream",
    ports: ["log"],
    steps: [
      { op: "append", args: ["jobs", { n: 1 }], expect: { value: true } },
      { op: "append", args: ["jobs", { n: 2 }], expect: { value: true } },
      { op: "append", args: ["流 / events", { n: 1 }], expect: { value: true } },
      { op: "append", args: ["jobs", { n: 3 }], expect: { value: true } },
      { op: "append", args: ["Jobs", { n: 1 }], expect: { value: true } },
      { op: "lastSequence", args: ["jobs"], expect: { value: true } },
      { op: "lastSequence", args: ["流 / events"], expect: { value: true } },
      { op: "lastSequence", args: ["Jobs"], expect: { value: true } },
      { op: "list", args: ["jobs"], expect: { value: true } },
      { op: "list", args: ["流 / events"], expect: { value: true } },
      { op: "get", args: ["Jobs", 2], expect: { value: true } },
    ],
  }),

  defineScenario({
    id: "log/get-by-sequence",
    title: "get returns the entry at a sequence, and null past the end or on an empty stream",
    ports: ["log"],
    steps: [
      { op: "get", args: ["s", 1], expect: { value: true } },
      ...FIVE.slice(0, 3),
      { op: "get", args: ["s", 1], expect: { value: true } },
      { op: "get", args: ["s", 3], expect: { value: true } },
      { op: "get", args: ["s", 4], expect: { value: true } },
      { op: "get", args: ["s", 9007199254740991], expect: { value: true } },
      { op: "get", args: ["other", 1], expect: { value: true } },
    ],
  }),

  defineScenario({
    id: "log/list-after-with-limit",
    title: "list returns entries after a sequence, in order, at most limit of them",
    ports: ["log"],
    steps: [
      ...FIVE,
      { op: "list", args: ["s", {}], expect: { value: true } },
      { op: "list", args: ["s", { after: 2 }], expect: { value: true } },
      { op: "list", args: ["s", { after: 2, limit: 2 }], expect: { value: true } },
      { op: "list", args: ["s", { limit: 1 }], expect: { value: true } },
      { op: "list", args: ["s", { after: 3, limit: 100 }], expect: { value: true } },
      { op: "list", args: ["s", { limit: 0 }], expect: { value: true } },
      { op: "list", args: ["s", { after: 5 }], expect: { value: true } },
      { op: "list", args: ["s", { after: 99, limit: 3 }], expect: { value: true } },
    ],
  }),

  defineScenario({
    id: "log/empty-stream",
    title: "a stream nothing was appended to lists nothing and its last sequence is 0",
    ports: ["log"],
    steps: [
      { op: "list", args: ["never"], expect: { value: true } },
      { op: "list", args: ["never", { after: 0, limit: 10 }], expect: { value: true } },
      { op: "lastSequence", args: ["never"], expect: { value: true } },
      { op: "append", args: ["other", 1] },
      { op: "lastSequence", args: ["never"], expect: { value: true } },
    ],
  }),

  defineScenario({
    id: "log/json-record-fidelity",
    title: "every JSON value comes back as it was appended",
    ports: ["log"],
    steps: [
      { op: "append", args: ["j", null] },
      { op: "append", args: ["j", true] },
      { op: "append", args: ["j", 0] },
      { op: "append", args: ["j", -1.5] },
      { op: "append", args: ["j", 1e300] },
      { op: "append", args: ["j", 9007199254740991] },
      { op: "append", args: ["j", ""] },
      { op: "append", args: ["j", "é 🔥 \u0000 \"quoted\" \\ \n"] },
      { op: "append", args: ["j", []] },
      { op: "append", args: ["j", {}] },
      {
        op: "append",
        args: [
          "j",
          {
            kind: "submitted",
            zeta: [1, "two", null, false, { deep: [[]] }],
            alpha: { "": "empty key", "key with spaces": 0.1 },
            "10": "numeric-looking key",
          },
        ],
      },
      { op: "list", args: ["j"], expect: { value: true } },
      { op: "get", args: ["j", 1], expect: { value: true } },
      { op: "get", args: ["j", 11], expect: { value: true } },
    ],
  }),

  defineScenario({
    id: "log/rolled-back-append-reuses-its-sequence",
    title: "an append whose transaction rolls back leaves no entry, and the next append gets its sequence",
    ports: ["log"],
    steps: [
      { op: "append", args: ["s", "kept"], expect: { value: true } },
      { op: "appendRolledBack", args: ["s", "rolled back"], expect: { value: true } },
      { op: "lastSequence", args: ["s"], expect: { value: true } },
      { op: "get", args: ["s", 2], expect: { value: true } },
      { op: "append", args: ["s", "next"], expect: { value: true } },
      { op: "list", args: ["s"], expect: { value: true } },
    ],
  }),

  defineScenario({
    id: "log/rolled-back-first-append",
    title: "a rolled-back first append leaves the stream empty, and the next append gets 1",
    ports: ["log"],
    steps: [
      { op: "appendRolledBack", args: ["fresh", { n: 1 }], expect: { value: true } },
      { op: "lastSequence", args: ["fresh"], expect: { value: true } },
      { op: "list", args: ["fresh"], expect: { value: true } },
      { op: "append", args: ["fresh", { n: 2 }], expect: { value: true } },
      { op: "get", args: ["fresh", 1], expect: { value: true } },
    ],
  }),

  defineScenario({
    id: "log/invalid-arguments",
    title: "unusable streams, sequences and bounds are refused and consume no sequence",
    ports: ["log"],
    steps: [
      { op: "append", args: ["", 1], expect: { throws: true } },
      { op: "lastSequence", args: [""], expect: { throws: true } },
      { op: "get", args: ["s", 0], expect: { throws: true } },
      { op: "get", args: ["s", -1], expect: { throws: true } },
      { op: "get", args: ["s", 1.5], expect: { throws: true } },
      { op: "get", args: ["s", "1"], expect: { throws: true } },
      { op: "get", args: ["s", 9007199254740992], expect: { throws: true } },
      { op: "list", args: ["s", { after: -1 }], expect: { throws: true } },
      { op: "list", args: ["s", { after: 0.5 }], expect: { throws: true } },
      { op: "list", args: ["s", { after: null }], expect: { throws: true } },
      { op: "list", args: ["s", { limit: -1 }], expect: { throws: true } },
      { op: "list", args: ["s", { limit: 2.5 }], expect: { throws: true } },
      { op: "list", args: ["s", { limit: null }], expect: { throws: true } },
      { op: "append", args: ["s", 1], expect: { value: true } },
    ],
  }),
];
