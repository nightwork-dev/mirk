import { defineScenario } from "../../src/conformance/define.js";

export const scenarios = [
  defineScenario({
    id: "coordination/immediate-fenced-lease-lifecycle",
    title:
      "Immediate leases expose contention, exact expiry, renewal and persistent fencing",
    ports: ["coordination"],
    steps: [
      { op: "acquire", args: ["old", "key", 100], expect: { value: true } },
      { op: "acquire", args: ["held", "key", 100], expect: { value: true } },
      { op: "advance", args: [99] },
      { op: "owned", args: ["old"], expect: { value: true } },
      { op: "renew", args: ["old", 100], expect: { value: true } },
      { op: "advance", args: [100] },
      { op: "owned", args: ["old"], expect: { value: true } },
      { op: "acquire", args: ["new", "key", 100], expect: { value: true } },
      { op: "renew", args: ["old", 100], expect: { value: true } },
      { op: "release", args: ["old"], expect: { value: true } },
      { op: "owned", args: ["new"], expect: { value: true } },
      { op: "release", args: ["new"], expect: { value: true } },
      { op: "release", args: ["new"], expect: { value: true } },
      { op: "acquire", args: ["third", "key", 100], expect: { value: true } },
    ],
  }),
];
