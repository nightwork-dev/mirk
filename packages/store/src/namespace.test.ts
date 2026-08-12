import { describe, expect, it } from "vitest";

import { InMemoryStore } from "./backends/memory.js";
import { namespaceStore } from "./namespace.js";
import {
  AtomicMutationRejectedError,
  supportsAtomicMutation,
} from "./atomic.js";

describe("namespaceStore", () => {
  it("isolates identical keys and collection ids in one backing store", () => {
    const backing = new InMemoryStore();
    const first = namespaceStore(backing, "first");
    const second = namespaceStore(backing, "second");

    first.set("same", "first-value");
    second.set("same", "second-value");
    first.put("records", { id: "same", value: "first-record" });
    second.put("records", { id: "same", value: "second-record" });

    expect(first.get("same")).toBe("first-value");
    expect(second.get("same")).toBe("second-value");
    expect(first.getById("records", "same")).toEqual({
      id: "same",
      value: "first-record",
    });
    expect(second.getById("records", "same")).toEqual({
      id: "same",
      value: "second-record",
    });
  });

  it("returns namespace-local keys without exposing storage prefixes", () => {
    const backing = new InMemoryStore();
    const first = namespaceStore(backing, "first");
    const second = namespaceStore(backing, "second");

    first.set("item:a", 1);
    first.set("item:b", 2);
    second.set("item:c", 3);

    expect(first.keys()).toEqual(["item:a", "item:b"]);
    expect(first.keys("item:")).toEqual(["item:a", "item:b"]);
  });

  it("rejects namespaces that could collide with the physical encoding", () => {
    const backing = new InMemoryStore();
    expect(() => namespaceStore(backing, "")).toThrow(
      "namespace must be non-empty"
    );
    expect(() => namespaceStore(backing, "bad\u001fnamespace")).toThrow(
      "unit separator"
    );
  });

  it("preserves typed validation for malformed atomic requests", () => {
    const backing = new InMemoryStore();
    const namespaced = namespaceStore(backing, "test");
    if (!supportsAtomicMutation(namespaced))
      throw new Error("expected atomic capability");

    const operations = [] as unknown as Array<{
      op: "set";
      key: string;
      value: number;
    }>;
    operations.length = 1;
    expect(() => namespaced.mutateAtomically({ operations })).toThrowError(
      AtomicMutationRejectedError
    );
    expect(() =>
      namespaced.mutateAtomically({
        operations: [{ op: "put", collection: "", item: { id: "x" } }],
      })
    ).toThrowError(AtomicMutationRejectedError);
  });
});
