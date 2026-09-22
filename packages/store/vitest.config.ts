import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Some suites fork worker processes that import from dist/.
    globalSetup: ["./scripts/build-dist.ts"],
    hookTimeout: 60_000,
  },
});
