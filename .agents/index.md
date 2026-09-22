# mirk — orientation for agents

Substrate-agnostic storage primitives with no application domain baked in, published under the
`@mirk/*` scope, with a Python port. Monorepo: pnpm + tsup + vitest; Python is a uv workspace.

## Where to read what

- [`README.md`](README.md) — what Mirk is and the package inventory.
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — build, test, conformance, and release commands.
- `packages/*/README.md`, `python/*/README.md` — each package's contract. These are the only
  specification; keep them current when behavior changes.
- [`conformance/README.md`](conformance/README.md) — the scenario format and its governance.
- [`docs/roadmap.md`](docs/roadmap.md) — shipped and planned primitives.

(Paths are relative to the repository root; this file is read as `AGENTS.md`.)

## Before claiming work is done

Run `pnpm test` and `pnpm -r typecheck`, plus the Python gates in each touched member of `python/`
(`uv run pytest -q`, `uv run pyright`, `uv run ruff check .`). Tests are real — real backends, real
persistence, real assertions — keep them that way.

## The conformance corpus is the contract

`conformance/**/*.json` is generated from `packages/store/scripts/scenarios/` and replayed by both
languages. Never hand-edit a scenario file. **A port behavior change lands with a scenario in the
same commit; a TypeScript-only test for port behavior is a review finding.** While drafting,
generate elsewhere with `pnpm --filter @mirk/store conformance:gen --out <scratch dir>`.

## Conventions

- **Code-split, one namespace.** Subpath entry points are declared explicitly in `package.json`
  exports. Import the specific subpath you need.
- **No barrel files.** `export *` is forbidden.
- **Ports vs source adapters.** Ports and in-memory references are zero-native. Source adapters
  implement ports over one backend connection and are the only place native bindings appear —
  never re-export an adapter from a port subpath.
- **Native deps are optional peers**, referenced only from the adapter that needs them.
- **Sync by design.** Embedded backends are synchronous; `toAsync` lifts a `SyncStore`. Don't make
  local calls async by default.
- **Standard Schema**, not zod, for data shapes.
- **Every package has a tsup build**; publish with `pnpm`, not `npm`.
- **Backend parity.** The in-memory reference and the SQLite adapter behave identically.
- **Docs are public.** Package READMEs carry the contract. Planning notes, handoffs, review
  transcripts, and evidence logs stay out of the repository; `pnpm docs:check` must pass.

## Working style

- macOS shell. Use `perl -pi -e` for in-place edits, not `sed`.
- Default to no comments; add one only when the why is non-obvious, and never cite a file that is
  not in the repository.
