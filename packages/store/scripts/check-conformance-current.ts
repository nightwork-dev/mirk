// ─── Conformance freshness gate ─────────────────────────────────────────────
// Generates a fresh corpus into a TEMPORARY directory and diffs that tree
// against the committed `conformance/`. Exits 1 listing every added, removed
// and changed file. The real corpus is never written by this check.
//
// Why not regenerate in place and read `git status`: the generator does
// `rm -rf` on the generated directories first, which is correct for a real
// regeneration (a scenario dropped from the generator must disappear rather
// than survive carrying a stale expectation) but fatal for a gate — it would
// overwrite the hand edit it exists to catch before anything could observe it.
// Diffing two trees catches all three directions without touching the corpus,
// and works the same in a checkout with no git history for the path.

import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";

import { DEFAULT_CORPUS_DIR, generate, reportSummary } from "./gen-conformance.js";

/** README.md is written by hand, not by the generator, so it is not compared. */
const NOT_GENERATED = new Set(["README.md"]);

function fileMap(root: string): Map<string, string> {
  const files = new Map<string, string>();
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      const key = relative(root, full).split(sep).join("/");
      if (NOT_GENERATED.has(key)) continue;
      files.set(key, readFileSync(full, "utf8"));
    }
  };
  walk(root);
  return files;
}

async function main(): Promise<void> {
  const temp = mkdtempSync(join(tmpdir(), "mirk-conformance-"));
  try {
    reportSummary(await generate(temp));

    const fresh = fileMap(temp);
    const committed = fileMap(DEFAULT_CORPUS_DIR);

    const added: string[] = [];
    const removed: string[] = [];
    const changed: string[] = [];
    for (const [path, body] of fresh) {
      const current = committed.get(path);
      if (current === undefined) added.push(path);
      else if (current !== body) changed.push(path);
    }
    for (const path of committed.keys()) {
      if (!fresh.has(path)) removed.push(path);
    }

    if (added.length + removed.length + changed.length > 0) {
      console.error("conformance corpus drifts from the TypeScript reference:");
      for (const path of added.sort()) console.error(`  added    conformance/${path}`);
      for (const path of removed.sort()) console.error(`  removed  conformance/${path}`);
      for (const path of changed.sort()) console.error(`  changed  conformance/${path}`);
      console.error("run `pnpm conformance:gen` and review the diff.");
      process.exit(1);
    }

    console.log("conformance corpus is current.");
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
