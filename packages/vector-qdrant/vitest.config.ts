import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Creating a real collection and its four indexes can exceed Vitest's 5s default.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
