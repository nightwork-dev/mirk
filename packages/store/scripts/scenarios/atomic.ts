// ─── Scenarios: the atomic mutation API ─────────────────────────────────────
// The `atomic` port binds the store target and adds two ops, `getVersioned` and
// `mutateAtomically`.
//
// Version tokens are compared BY EXACT VALUE. Both conformance stores are built
// with the version identity `"conformance"`, so a token reads `conformance-v<n>`
// and the corpus pins sequence allocation itself: the sequence starts at 1 per
// store, every `set`/`put` (plain or atomic) consumes one value, `delete` and
// `remove` consume none, and a conflict or a rejected request consumes none.
// Several scenarios end with a write to a fresh key purely to show which number
// comes next — that number is the evidence that nothing was consumed.
//
// Conditions are sorted by target before they are evaluated, so a conflict names
// the first failing condition in SORTED order rather than in the order the
// caller wrote them. Operations are never sorted: the `versions` array follows
// the request's operation order exactly.

import { defineScenario } from "../../src/conformance/define.js";

const KEY_A = { kind: "key", key: "a" };
const KEY_B = { kind: "key", key: "b" };
const RECORD_CX = { kind: "record", collection: "c", id: "x" };

/** One trivial operation per slot, one past this store's `maxOperations`
 *  (`IN_PROCESS_ATOMIC_LIMITS.maxOperations` is 4096). `delete` is the cheapest
 *  operation to serialize, and the limit is checked before any operation is
 *  normalized or applied. */
const OVER_OPERATION_LIMIT = Array.from({ length: 4097 }, (_, index) => ({
  op: "delete",
  key: `k${index}`,
}));

/** Canonicalizes to 65538 bytes, two past the fixed 65536-byte outcome cap. */
const OVERSIZED_OUTCOME = "a".repeat(65536);

/** The same request in two scenarios against two fresh stores. Its digest is a
 *  function of the operations alone, so both files must carry one string. */
const PINNED_REQUEST = {
  operations: [{ op: "set", key: "pin", value: true }],
};

function reject(name: string, title: string, request: unknown, ports = ["atomic"]) {
  return defineScenario({
    id: `store/atomic/${name}`,
    title,
    ports,
    steps: [{ op: "mutateAtomically", args: [request], expect: { throws: true } }],
  });
}

export const scenarios = [
  // ── getVersioned ────────────────────────────────────────────────────────
  defineScenario({
    id: "store/atomic/get-versioned-missing-key",
    title: "getVersioned on a key that was never written is null",
    ports: ["atomic"],
    steps: [{ op: "getVersioned", args: [KEY_A], expect: { value: true } }],
  }),

  defineScenario({
    id: "store/atomic/get-versioned-missing-record",
    title: "getVersioned on a record in a collection that does not exist is null",
    ports: ["atomic"],
    steps: [{ op: "getVersioned", args: [RECORD_CX], expect: { value: true } }],
  }),

  defineScenario({
    id: "store/atomic/get-versioned-after-set",
    title: "a plain set mints the first version token of the store",
    ports: ["atomic", "kv"],
    steps: [
      { op: "set", args: ["a", { n: 1 }] },
      { op: "getVersioned", args: [KEY_A], expect: { value: true } },
    ],
  }),

  defineScenario({
    id: "store/atomic/get-versioned-after-put",
    title: "a plain put mints a version token for the record target",
    ports: ["atomic", "collection"],
    steps: [
      { op: "put", args: ["c", { id: "x", n: 1 }] },
      { op: "getVersioned", args: [RECORD_CX], expect: { value: true } },
    ],
  }),

  defineScenario({
    id: "store/atomic/sequence-allocation-across-mixed-writes",
    title: "one sequence serves keys and records alike, in write order",
    ports: ["atomic", "kv", "collection"],
    steps: [
      { op: "set", args: ["a", 1] },
      { op: "put", args: ["c", { id: "x" }] },
      { op: "set", args: ["b", 2] },
      { op: "getVersioned", args: [KEY_A], expect: { value: true } },
      { op: "getVersioned", args: [RECORD_CX], expect: { value: true } },
      { op: "getVersioned", args: [KEY_B], expect: { value: true } },
    ],
  }),

  defineScenario({
    id: "store/atomic/delete-clears-the-version-token",
    title: "delete drops the key's token and consumes no sequence value; rewriting takes the next",
    ports: ["atomic", "kv"],
    steps: [
      { op: "set", args: ["a", 1] },
      { op: "set", args: ["b", 2] },
      { op: "delete", args: ["a"], expect: { value: true } },
      { op: "getVersioned", args: [KEY_A], expect: { value: true } },
      { op: "set", args: ["a", 3] },
      { op: "getVersioned", args: [KEY_A], expect: { value: true } },
      { op: "getVersioned", args: [KEY_B], expect: { value: true } },
    ],
  }),

  defineScenario({
    id: "store/atomic/remove-clears-the-version-token",
    title: "remove drops the record's token and consumes no sequence value",
    ports: ["atomic", "collection"],
    steps: [
      { op: "put", args: ["c", { id: "x" }] },
      { op: "put", args: ["c", { id: "y" }] },
      { op: "remove", args: ["c", "x"], expect: { value: true } },
      { op: "getVersioned", args: [RECORD_CX], expect: { value: true } },
      { op: "put", args: ["c", { id: "x", again: true }] },
      { op: "getVersioned", args: [RECORD_CX], expect: { value: true } },
    ],
  }),

  // ── mutateAtomically: applied results ───────────────────────────────────
  defineScenario({
    id: "store/atomic/versions-follow-operation-order",
    title: "the applied versions follow operation order, and delete and remove report null",
    ports: ["atomic"],
    steps: [
      {
        op: "mutateAtomically",
        args: [
          {
            operations: [
              { op: "set", key: "z", value: 1 },
              { op: "put", collection: "c", item: { id: "b", n: 2 } },
              { op: "delete", key: "a" },
              { op: "remove", collection: "c", id: "zz" },
            ],
          },
        ],
        expect: { value: true },
      },
      { op: "getVersioned", args: [{ kind: "key", key: "z" }], expect: { value: true } },
    ],
  }),

  // ── Conditions that hold ────────────────────────────────────────────────
  defineScenario({
    id: "store/atomic/condition-missing-satisfied",
    title: "a missing condition on an absent target lets the batch apply",
    ports: ["atomic"],
    steps: [
      {
        op: "mutateAtomically",
        args: [
          {
            conditions: [{ target: KEY_A, expected: "missing" }],
            operations: [{ op: "set", key: "a", value: 1 }],
          },
        ],
        expect: { value: true },
      },
      { op: "getVersioned", args: [KEY_A], expect: { value: true } },
    ],
  }),

  defineScenario({
    id: "store/atomic/condition-present-satisfied",
    title: "a present condition on a written target lets the batch apply",
    ports: ["atomic", "kv"],
    steps: [
      { op: "set", args: ["a", 1] },
      {
        op: "mutateAtomically",
        args: [
          {
            conditions: [{ target: KEY_A, expected: "present" }],
            operations: [{ op: "set", key: "a", value: 2 }],
          },
        ],
        expect: { value: true },
      },
      { op: "getVersioned", args: [KEY_A], expect: { value: true } },
    ],
  }),

  defineScenario({
    id: "store/atomic/condition-version-satisfied",
    title: "a version condition matching the current token lets the batch apply",
    ports: ["atomic", "kv"],
    steps: [
      { op: "set", args: ["a", 1] },
      {
        op: "mutateAtomically",
        args: [
          {
            conditions: [
              { target: KEY_A, expected: "version", version: "conformance-v1" },
            ],
            operations: [{ op: "set", key: "a", value: 2 }],
          },
        ],
        expect: { value: true },
      },
      { op: "getVersioned", args: [KEY_A], expect: { value: true } },
    ],
  }),

  // ── Conditions that conflict ────────────────────────────────────────────
  defineScenario({
    id: "store/atomic/condition-missing-conflict",
    title: "a missing condition on a written target conflicts and observes present",
    ports: ["atomic", "kv"],
    steps: [
      { op: "set", args: ["a", 1] },
      {
        op: "mutateAtomically",
        args: [
          {
            conditions: [{ target: KEY_A, expected: "missing" }],
            operations: [{ op: "set", key: "b", value: 2 }],
          },
        ],
        expect: { value: true },
      },
      { op: "getVersioned", args: [KEY_B], expect: { value: true } },
      { op: "set", args: ["c", 3] },
      { op: "getVersioned", args: [{ kind: "key", key: "c" }], expect: { value: true } },
    ],
  }),

  defineScenario({
    id: "store/atomic/condition-present-conflict",
    title: "a present condition on an absent target conflicts and observes missing",
    ports: ["atomic", "kv"],
    steps: [
      {
        op: "mutateAtomically",
        args: [
          {
            conditions: [{ target: KEY_A, expected: "present" }],
            operations: [{ op: "set", key: "b", value: 2 }],
          },
        ],
        expect: { value: true },
      },
      { op: "getVersioned", args: [KEY_B], expect: { value: true } },
      { op: "set", args: ["c", 3] },
      { op: "getVersioned", args: [{ kind: "key", key: "c" }], expect: { value: true } },
    ],
  }),

  defineScenario({
    id: "store/atomic/condition-version-conflict",
    title: "a stale version condition conflicts and observes the current token",
    ports: ["atomic", "kv"],
    steps: [
      { op: "set", args: ["a", 1] },
      {
        op: "mutateAtomically",
        args: [
          {
            conditions: [
              { target: KEY_A, expected: "version", version: "conformance-v9" },
            ],
            operations: [{ op: "set", key: "b", value: 2 }],
          },
        ],
        expect: { value: true },
      },
      { op: "getVersioned", args: [KEY_B], expect: { value: true } },
      { op: "set", args: ["c", 3] },
      { op: "getVersioned", args: [{ kind: "key", key: "c" }], expect: { value: true } },
    ],
  }),

  defineScenario({
    id: "store/atomic/conflict-reports-the-first-condition-in-sorted-order",
    title:
      "with two failing conditions authored out of order, the conflict names the one that sorts first",
    ports: ["atomic"],
    steps: [
      {
        op: "mutateAtomically",
        args: [
          {
            conditions: [
              { target: { kind: "key", key: "z" }, expected: "present" },
              { target: KEY_A, expected: "present" },
            ],
            operations: [{ op: "set", key: "m", value: 1 }],
          },
        ],
        expect: { value: true },
      },
      { op: "getVersioned", args: [{ kind: "key", key: "m" }], expect: { value: true } },
    ],
  }),

  // ── Idempotency ─────────────────────────────────────────────────────────
  defineScenario({
    id: "store/atomic/idempotency-replay-returns-the-original-result",
    title: "replaying an identical request returns replayed with the same versions and outcome",
    ports: ["atomic"],
    steps: [
      {
        op: "mutateAtomically",
        args: [
          {
            operations: [{ op: "set", key: "a", value: 1 }],
            idempotency: { key: "req-1", outcome: { ok: true, id: "r1" } },
          },
        ],
        expect: { value: true },
      },
      {
        op: "mutateAtomically",
        args: [
          {
            operations: [{ op: "set", key: "a", value: 1 }],
            idempotency: { key: "req-1", outcome: { ok: true, id: "r1" } },
          },
        ],
        expect: { value: true },
      },
      { op: "getVersioned", args: [KEY_A], expect: { value: true } },
    ],
  }),

  defineScenario({
    id: "store/atomic/idempotency-conflict-on-a-different-request",
    title: "a different request under a used key is refused with both digests and writes nothing",
    ports: ["atomic", "kv"],
    steps: [
      {
        op: "mutateAtomically",
        args: [
          {
            operations: [{ op: "set", key: "a", value: 1 }],
            idempotency: { key: "req-1" },
          },
        ],
        expect: { value: true },
      },
      {
        op: "mutateAtomically",
        args: [
          {
            operations: [{ op: "set", key: "a", value: 2 }],
            idempotency: { key: "req-1" },
          },
        ],
        expect: { value: true },
      },
      { op: "get", args: ["a"], expect: { value: true } },
      { op: "getVersioned", args: [KEY_A], expect: { value: true } },
    ],
  }),

  defineScenario({
    id: "store/atomic/idempotency-replay-after-a-plain-overwrite",
    title: "a replay returns the versions the original produced, even after a plain set moved on",
    ports: ["atomic", "kv"],
    steps: [
      {
        op: "mutateAtomically",
        args: [
          {
            operations: [{ op: "set", key: "a", value: 1 }],
            idempotency: { key: "req-1" },
          },
        ],
        expect: { value: true },
      },
      { op: "set", args: ["a", 99] },
      { op: "getVersioned", args: [KEY_A], expect: { value: true } },
      {
        op: "mutateAtomically",
        args: [
          {
            operations: [{ op: "set", key: "a", value: 1 }],
            idempotency: { key: "req-1" },
          },
        ],
        expect: { value: true },
      },
      { op: "get", args: ["a"], expect: { value: true } },
    ],
  }),

  // ── The request digest ──────────────────────────────────────────────────
  defineScenario({
    id: "store/atomic/request-digest-ignores-the-idempotency-key",
    title:
      "the same operations under two idempotency keys apply twice with one requestDigest; a reader of the corpus compares the two digest strings",
    ports: ["atomic"],
    steps: [
      {
        op: "mutateAtomically",
        args: [
          {
            operations: [{ op: "set", key: "a", value: true }],
            idempotency: { key: "one" },
          },
        ],
        expect: { value: true },
      },
      {
        op: "mutateAtomically",
        args: [
          {
            operations: [{ op: "set", key: "a", value: true }],
            idempotency: { key: "two" },
          },
        ],
        expect: { value: true },
      },
    ],
  }),

  defineScenario({
    id: "store/atomic/request-digest-stable-across-stores-first",
    title:
      "the digest of the pinned request in a fresh store; its sibling scenario must carry the same string",
    ports: ["atomic"],
    steps: [{ op: "mutateAtomically", args: [PINNED_REQUEST], expect: { value: true } }],
  }),

  defineScenario({
    id: "store/atomic/request-digest-stable-across-stores-second",
    title:
      "the same pinned request in a store that already wrote: a different version, the same digest",
    ports: ["atomic", "kv"],
    steps: [
      { op: "set", args: ["other", 1] },
      { op: "mutateAtomically", args: [PINNED_REQUEST], expect: { value: true } },
    ],
  }),

  // ── Rejections reachable from JSON input ────────────────────────────────
  reject("reject-request-not-an-object", "a request that is not an object is refused", "nope"),
  reject("reject-empty-operations", "a request with no operations is refused", {
    operations: [],
  }),
  reject("reject-non-array-conditions", "conditions that are not an array are refused", {
    conditions: { target: KEY_A, expected: "missing" },
    operations: [{ op: "set", key: "a", value: 1 }],
  }),
  reject("reject-condition-not-an-object", "a condition that is not an object is refused", {
    conditions: ["a"],
    operations: [{ op: "set", key: "a", value: 1 }],
  }),
  reject("reject-invalid-target-kind", "a target of an unknown kind is refused", {
    conditions: [{ target: { kind: "blob", key: "a" }, expected: "missing" }],
    operations: [{ op: "set", key: "a", value: 1 }],
  }),
  reject("reject-key-target-without-a-string-key", "a key target needs a string key", {
    conditions: [{ target: { kind: "key", key: 5 }, expected: "missing" }],
    operations: [{ op: "set", key: "a", value: 1 }],
  }),
  reject(
    "reject-record-target-with-an-empty-collection",
    "a record target needs a non-empty collection",
    {
      conditions: [
        { target: { kind: "record", collection: "", id: "x" }, expected: "missing" },
      ],
      operations: [{ op: "set", key: "a", value: 1 }],
    },
  ),
  reject(
    "reject-invalid-condition-expectation",
    "a condition expectation outside missing, present and version is refused",
    {
      conditions: [{ target: KEY_A, expected: "absent" }],
      operations: [{ op: "set", key: "a", value: 1 }],
    },
  ),
  reject(
    "reject-repeated-condition-target",
    "two conditions on one target are refused rather than silently combined",
    {
      conditions: [
        { target: KEY_A, expected: "present" },
        { target: KEY_A, expected: "missing" },
      ],
      operations: [{ op: "set", key: "a", value: 1 }],
    },
  ),
  reject("reject-operation-without-an-op", "an operation with no op name is refused", {
    operations: [{ key: "a", value: 1 }],
  }),
  reject("reject-set-without-a-string-key", "set needs a string key", {
    operations: [{ op: "set", key: 5, value: 1 }],
  }),
  reject("reject-delete-without-a-string-key", "delete needs a string key", {
    operations: [{ op: "delete", key: 5 }],
  }),
  reject("reject-put-with-an-empty-collection", "put needs a non-empty collection", {
    operations: [{ op: "put", collection: "", item: { id: "x" } }],
  }),
  reject("reject-remove-with-an-empty-collection", "remove needs a non-empty collection", {
    operations: [{ op: "remove", collection: "", id: "x" }],
  }),
  reject(
    "reject-repeated-operation-target",
    "two operations on one target are refused rather than applied in sequence",
    {
      operations: [
        { op: "set", key: "a", value: 1 },
        { op: "set", key: "a", value: 2 },
      ],
    },
  ),
  reject("reject-non-string-idempotency-key", "an idempotency key must be a string", {
    operations: [{ op: "set", key: "a", value: 1 }],
    idempotency: { key: 7 },
  }),
  reject("reject-unsupported-operation-name", "an unknown operation name is refused by name", {
    operations: [{ op: "increment", key: "a", by: 1 }],
  }),
  reject(
    "reject-operation-limit-exceeded",
    "one operation past this store's maxOperations is refused before anything is applied",
    { operations: OVER_OPERATION_LIMIT },
  ),
  reject(
    "reject-outcome-size-exceeded",
    "an idempotency outcome past the fixed 64 KiB cap is refused",
    {
      operations: [{ op: "set", key: "a", value: 1 }],
      idempotency: { key: "req-1", outcome: OVERSIZED_OUTCOME },
    },
  ),

  // ── Lone surrogates in atomic values ────────────────────────────────────
  // A lone surrogate is contractual as a VALUE (set value, put field, outcome):
  // the request digest canonicalizes it as a `\u` escape and the store writes
  // it escaped. A port whose storage encoder emits it raw cannot write it to
  // SQLite, and the receipt it replays would differ. Identifiers stay ASCII;
  // see the store scenario of the same name for why.
  defineScenario({
    id: "store/atomic/lone-surrogate-values",
    title: "a lone surrogate in a set value, a put field and an outcome is applied, digested and replayed",
    ports: ["atomic"],
    steps: [
      {
        op: "mutateAtomically",
        args: [
          {
            conditions: [{ target: { kind: "key", key: "lone" }, expected: "missing" }],
            operations: [
              { op: "set", key: "lone", value: "x\udc00y" },
              { op: "put", collection: "s", item: { id: "r", text: "\ud800", pair: "😀" } },
            ],
            idempotency: { key: "k1", outcome: { echo: "\udfff" } },
          },
        ],
        expect: { value: true },
      },
      { op: "getVersioned", args: [{ kind: "key", key: "lone" }], expect: { value: true } },
      {
        op: "getVersioned",
        args: [{ kind: "record", collection: "s", id: "r" }],
        expect: { value: true },
      },
      {
        op: "mutateAtomically",
        args: [
          {
            conditions: [{ target: { kind: "key", key: "lone" }, expected: "missing" }],
            operations: [
              { op: "set", key: "lone", value: "x\udc00y" },
              { op: "put", collection: "s", item: { id: "r", text: "\ud800", pair: "😀" } },
            ],
            idempotency: { key: "k1", outcome: { echo: "\udfff" } },
          },
        ],
        expect: { value: true },
      },
    ],
  }),
];
