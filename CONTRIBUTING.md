# Contributing to mirk

## Develop

```bash
pnpm install
pnpm build          # tsup, per package
pnpm test           # vitest — real backends, real persistence, real assertions
pnpm -r typecheck
pnpm docs:check     # public links, package metadata, and workspace READMEs
```

The Python port is a uv workspace at `python/` with members `store`, `fixtures`, `artifact`,
`store-markdown`, `artifact-opendal`, and `vector-qdrant`.
Run each member's gates from inside it:

```bash
cd python
uv sync --all-packages --locked --group dev
cd store             # or another workspace member
uv run pytest -q
uv run pyright
uv run ruff check .
```

The artifact and Markdown packages run TypeScript exchange tests. These tests rebuild their
TypeScript dependencies. Run package tests sequentially to avoid competing writes to `dist`.

The S3 integration test requires a real service. The supplied harness starts an isolated MinIO
server, creates a temporary bucket, runs the configured tests, and stops the server:

```bash
python3 scripts/run-python-s3-tests.py
```

The harness builds a pinned MinIO source release when `MINIO_BINARY` is unset. This requires Go.
It does not use cloud credentials or a production bucket. The separate S3 CI job runs the same proof.

The direct OpenDAL S3 integration tests use these explicit settings:
`MIRK_OPENDAL_S3_ENDPOINT`, `MIRK_OPENDAL_S3_BUCKET`,
`MIRK_OPENDAL_S3_ACCESS_KEY_ID`, and `MIRK_OPENDAL_S3_SECRET_ACCESS_KEY`.
`MIRK_OPENDAL_S3_REGION` is optional. The tests do not access cloud resources
without these settings.

The Qdrant adapters use a separate real-server harness:

```bash
pnpm build
python3 scripts/run-qdrant-tests.py
```

The harness downloads a pinned Qdrant binary, verifies its checksum, and starts it with temporary
storage on loopback. It runs both languages against that server and rejects skipped or empty suites.
It also writes and reopens records across the two adapters to check their shared storage format.
`QDRANT_BINARY` selects an existing binary of the pinned version. `MIRK_QDRANT_PYTHON` selects an
interpreter with installed wheels; the harness verifies that its imports come from `site-packages`.
For an existing test service, set `MIRK_QDRANT_URL` when running either adapter's tests directly.
Each test creates and removes its own physical collection.

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
PostgreSQL; the publication receipt refuses that package unless its integration tests execute.
