// Builds dist/ once before any test file runs.
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export default function setup(): void {
  execFileSync("pnpm", ["--filter", "@mirk/store", "build"], {
    cwd: packageRoot,
    stdio: "inherit",
  });
}
