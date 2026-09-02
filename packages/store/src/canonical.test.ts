// ─── canonical.ts ───────────────────────────────────────────────────────────
// The language-local half of the hashing contract. The corpus pins everything a
// Python port must reproduce; this file pins the rest: the rejections that have
// no JSON representation (a sparse array, a symbol key, `undefined`, a class
// instance, a cycle) and the claim the corpus cannot make about itself — that
// the hand-rolled digest IS SHA-256, checked against node:crypto.

import { describe, expect, it } from "vitest";
import { createHash, randomBytes } from "node:crypto";

import {
  canonicalDigest,
  canonicalJson,
  sha256Hex,
  sha256HexBytes,
} from "./canonical.js";

function nodeSha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

describe("canonicalJson rejections with no JSON representation", () => {
  it("rejects a sparse array", () => {
    const sparse = [1, , 3] as unknown[];
    expect(() => canonicalJson(sparse)).toThrow("sparse arrays are not JSON-safe");
  });

  it("rejects an array carrying an extra enumerable property", () => {
    const value = [1, 2] as unknown as Record<string, unknown>;
    value.label = "extra";
    expect(() => canonicalJson(value)).toThrow("array properties are not JSON-safe");
  });

  it("rejects an index alias that JSON.stringify would silently drop", () => {
    const value = [1] as unknown as Record<string, unknown>;
    value["01"] = "alias";
    expect(() => canonicalJson(value)).toThrow("array properties are not JSON-safe");
  });

  it("rejects a symbol-keyed property", () => {
    expect(() => canonicalJson({ a: 1, [Symbol("s")]: 2 })).toThrow(
      "symbol keys are not JSON-safe",
    );
  });

  it("rejects undefined and functions", () => {
    expect(() => canonicalJson(undefined)).toThrow("value is not JSON-safe");
    expect(() => canonicalJson(() => 1)).toThrow("value is not JSON-safe");
    expect(() => canonicalJson({ a: undefined })).toThrow("value is not JSON-safe");
  });

  it("rejects a Date, a Map and a class instance rather than coercing them", () => {
    class Thing {
      value = 1;
    }
    expect(() => canonicalJson(new Date(0))).toThrow("only plain objects are JSON-safe");
    expect(() => canonicalJson(new Map())).toThrow("only plain objects are JSON-safe");
    expect(() => canonicalJson(new Thing())).toThrow("only plain objects are JSON-safe");
  });

  it("accepts a null-prototype object", () => {
    const value = Object.create(null) as Record<string, unknown>;
    value.a = 1;
    expect(canonicalJson(value)).toBe('{"a":1}');
  });

  it("rejects a cycle through an object and through an array", () => {
    const object: Record<string, unknown> = {};
    object.self = object;
    expect(() => canonicalJson(object)).toThrow("cyclic values are not JSON-safe");

    const array: unknown[] = [];
    array.push(array);
    expect(() => canonicalJson(array)).toThrow("cyclic values are not JSON-safe");
  });

  it("accepts the same object appearing twice without a cycle", () => {
    const shared = { a: 1 };
    expect(canonicalJson([shared, shared])).toBe('[{"a":1},{"a":1}]');
  });
});

describe("sha256Hex agrees with node:crypto", () => {
  const inputs: Record<string, string> = {
    empty: "",
    short: "hello",
    // 55 bytes: the last length that fits one padded block.
    "one block boundary": "a".repeat(55),
    // 56 bytes: the length that forces a second block.
    "two blocks": "a".repeat(56),
    "past 64 bytes": "a".repeat(100),
    "past 128 bytes": "b".repeat(200),
    "non-ascii": "café ünï 中文 😀",
    "line separators": "\u2028\u2029",
  };

  for (const [name, input] of Object.entries(inputs)) {
    it(name, () => {
      expect(sha256Hex(input)).toBe(nodeSha256(input));
    });
  }

  it("hashes a 1 MB input", () => {
    const input = "mirk".repeat(262_144);
    expect(input.length).toBe(1_048_576);
    expect(sha256Hex(input)).toBe(nodeSha256(input));
  });

  it("hashes raw bytes, including every byte value and a random blob", () => {
    const allBytes = Uint8Array.from({ length: 256 }, (_, i) => i);
    expect(sha256HexBytes(allBytes)).toBe(
      createHash("sha256").update(allBytes).digest("hex"),
    );
    const blob = new Uint8Array(randomBytes(4096));
    expect(sha256HexBytes(blob)).toBe(createHash("sha256").update(blob).digest("hex"));
  });

  it("hashes bytes of a subarray without reading past its window", () => {
    const backing = Uint8Array.from([9, 9, 1, 2, 3, 9, 9]);
    const window = backing.subarray(2, 5);
    expect(sha256HexBytes(window)).toBe(
      createHash("sha256").update(Uint8Array.from([1, 2, 3])).digest("hex"),
    );
  });
});

describe("canonicalDigest", () => {
  it("is the sha256 of the canonical text", () => {
    const value = { b: 1, a: [2, { c: null }] };
    expect(canonicalJson(value)).toBe('{"a":[2,{"c":null}],"b":1}');
    expect(canonicalDigest(value)).toBe(nodeSha256(canonicalJson(value)));
  });

  it("throws the canonicalization error rather than digesting a rejected value", () => {
    expect(() => canonicalDigest(Number.NaN)).toThrow(
      "non-finite numbers are not JSON-safe",
    );
  });
});
