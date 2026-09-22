# Contributing to mirk

## Develop

```bash
pnpm install
pnpm build          # tsup, per package
pnpm test           # vitest — real backends, real persistence, real assertions
pnpm -r typecheck
pnpm docs:check     # relative links and public package metadata
```

The Python port is a uv workspace at `python/` with members `store` and `fixtures`. Run each
member's gates from inside it:

```bash
cd python/store     # or python/fixtures
uv run pytest -q
uv run pyright
uv run ruff check .
```

## The conformance corpus

`conformance/**/*.json` is generated from `packages/store/scripts/scenarios/` and replayed by both
the TypeScript and Python suites. Never hand-edit a scenario file. A change to port behavior lands
with a scenario in the same commit.

```bash
pnpm conformance:gen      # rewrite the shared corpus
pnpm conformance:current  # regenerate into a temporary tree and diff; fails on drift
```

The corpus format and its governance are in [`conformance/README.md`](conformance/README.md).

## Conventions

- **No barrels.** `export *` is forbidden; every entry declares explicit named re-exports.
- **Ports stay native-free.** Never re-export a source adapter from a port subpath, or a bundler
  will pull native code into a client build.
- **Native dependencies are optional peers**, referenced only from the adapter that needs them.
- **Every package has a tsup build.** `publishConfig` rewrites entry points to `dist`; publish with
  `pnpm`, not `npm`.

## Release

Mirk uses Changesets. Do not hand-bump package versions.

```bash
pnpm changeset                  # describe package-impacting changes
pnpm version-packages           # apply versions from pending changesets
pnpm release                    # build, then changeset publish
pnpm release:verify -- --all    # check tarballs, exports, and a clean install per package
pnpm release:receipt -- --all   # the same checks, requiring a clean source tree
```

`release:receipt` writes a receipt that names the source commit and the number of tests each
package executed. `@mirk/store-postgres` needs `MIRK_POSTGRES_TEST_URL` pointing at a live
PostgreSQL; without it the suite skips and no receipt is written.
