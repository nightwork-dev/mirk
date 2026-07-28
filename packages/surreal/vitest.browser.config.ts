import { defineConfig } from "vitest/config";
import { existsSync } from "node:fs";

const localChrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

export default defineConfig({
  assetsInclude: ["**/*.wasm"],
  optimizeDeps: {
    exclude: ["@surrealdb/wasm"],
  },
  test: {
    include: ["src/**/*.browser.test.ts"],
    browser: {
      enabled: true,
      headless: true,
      provider: "playwright",
      instances: [
        {
          browser: "chromium",
          launch: existsSync(localChrome) ? { executablePath: localChrome } : {},
        },
      ],
    },
  },
});
