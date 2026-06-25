# mirk — orientation for agents

The dark foundational layer the rest of the stack is built on: substrate-agnostic storage
primitives that aren't tied to any one domain. A blog, a game, or an agent host can all draw from
it. Published under the `@mirk/*` scope.

Monorepo (pnpm + tsup + vitest). Current packages include `@mirk/store` and source adapters such as `@mirk/store-libsql`; planned primitives are tracked in `docs/roadmap.md`.

## Build / test

```bash
pnpm install
pnpm build      # tsup, per package
pnpm test       # vitest across all packages
pnpm -r typecheck
```

Always run `pnpm test` and `pnpm typecheck` before claiming work is done. Tests are real (real
backends, real persistence, real assertions) — keep them that way.

## Where to read what

- [`README.md`](../README.md) — the monorepo overview.
- [`packages/store/README.md`](../packages/store/README.md) — `@mirk/store` install + usage.
- [`docs/roadmap.md`](../docs/roadmap.md) — planned substrate primitives.
- [`docs/fixtures-spec.md`](../docs/fixtures-spec.md) — draft `@mirk/fixtures` public package spec.

## Conventions enforced at review time

- **Code-split, one namespace.** `@mirk/store` exposes subpath entry points (`/kv`, `/vector`,
  `/sqlite`) declared explicitly in `package.json` exports. Import the specific subpath you need.
- **No barrel files.** `export *` is forbidden. Each entry declares explicit named re-exports.
- **Ports vs source adapters.** The interface ports (`SyncStore`, `VectorStore`) and their
  in-memory references are **zero-native** and live at the root / `/kv` / `/vector`. Source
  adapters (e.g. `/sqlite`) implement one or more ports over a single backend connection and are
  the **only** place native bindings appear — never re-export an adapter from a port subpath, or a
  bundler will drag native code into a client build.
- **Native deps are optional peers.** `better-sqlite3` and `sqlite-vec` are optional
  `peerDependencies` referenced solely from the sqlite adapter. Installing `@mirk/store` pulls no
  binding.
- **Sync by design.** Embedded backends are synchronous (better-sqlite3 is sync). A `SyncStore`
  lifts to async via `toAsync`; the reverse is impossible. Don't make local calls async-by-default.
- **Standard Schema**, not zod, for any tool/data shapes.
- **Each package has a tsup build.** Never ship raw `.ts` as the published entry — `publishConfig`
  rewrites `main`/`exports` to `dist` at publish time (publish with `pnpm`, not `npm`).
- **Backend parity.** The in-memory reference and the sqlite adapter must behave identically
  (ordering, tie-breaks, null/zero handling). Cross-backend parity tests are the contract.

## Working style

- macOS shell. Use `perl -pi -e` for in-place edits, not `sed`.
- Prefer editing existing files over creating new ones; don't ship `*.md` summaries unless asked.
- Default to no comments; add one only when the WHY is non-obvious.
