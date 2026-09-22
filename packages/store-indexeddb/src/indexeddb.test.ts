import { describe, expect, it } from "vitest";
import { IndexedDbConnectionError, openIndexedDbAdapter } from "./index.js";

describe("IndexedDB availability", () => {
  it("rejects with a coded error when no IndexedDB factory exists", async () => {
    if (typeof indexedDB !== "undefined") return;
    const opening = openIndexedDbAdapter();
    await expect(opening).rejects.toBeInstanceOf(IndexedDbConnectionError);
    await expect(opening).rejects.toMatchObject({ code: "unavailable", retryable: false });
  });
});
