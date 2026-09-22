import { defineConfig } from "vitest/config";
import { existsSync } from "node:fs";
import { chromium } from "playwright";

const localChrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const useLocalChrome = !existsSync(chromium.executablePath()) && existsSync(localChrome);

export default defineConfig({
  test: {
    include: ["src/**/*.browser.test.ts"],
    browser: {
      enabled: true,
      headless: true,
      provider: "playwright",
      instances: [
        {
          browser: "chromium",
          launch: useLocalChrome ? { executablePath: localChrome } : {},
        },
      ],
    },
  },
});
