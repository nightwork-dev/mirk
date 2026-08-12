# Mirk substrate closure specification

**Status:** receipt-green implementation; independent review pending

**Scope:** `@mirk/store`, `@mirk/fixtures`, `@mirk/artifact`,
`@mirk/migrate`, and source adapters

**Related roadmap items:** MR-07, MR-10, MR-15, MR-16, MR-17

## Decision

Mirk will finish and harden the substrate it already owns before adding new
storage categories or backend breadth.

The near program, with local implementation evidence recorded below, is:

1. make package and release state truthful;
2. add a backend-neutral atomic mutation capability without widening the base
   store ports;
3. harden artifact finalization, audit, and repair around that capability;
4. finish the authored-data CLI;
5. characterize SQLite concurrency through Mirk-owned generic harnesses; and
6. admit new adapters only when they can implement an existing port honestly.

Mirk will not maintain a conformance matrix of consuming projects.

Mirk owns:

- normative in-memory references;
- contract suites for public ports;
- adapter-specific contract suites;
- packed-package and export-boundary checks; and
- generic fault, persistence, and reopen fixtures.

Each consuming project owns its own integration tests, version pins, deployment
evidence, and adoption status. A consumer may supply a bounded reproduction that
motivates a Mirk contract, but Mirk does not retain a project/version/status
registry inside this repository.

## Summary

Mirk is the domain-neutral physical substrate beneath applications and
execution systems:

```text
ports
  stable storage semantics

source adapters
  backend-specific implementations of those semantics

fixtures
  validated and explainable authored inputs

artifacts
  immutable byte-bearing outputs with integrity and lineage

migrate
  checkpointed transfer between compatible ports
```

The current substrate train is `implemented` and `receipt-green`: all 10 package
release receipts pass from clean commit `d1f5dea`. The local sources include the
optional atomic mutation capability, artifact atomic finalization and
maintenance, the fixture CLI, SQLite inspection/checkpoint/fault evidence, and
plan-bound migration checkpoints. These remain capability-gated where a backend
cannot provide the required semantics.

`Verdaccio-published`, `public-npm-published`, `remote/tagged`,
`consumer-installed`, `consumer-adopted`, and `runtime/deployment-proven` are
separate evidence states. The current train is present in local Verdaccio, but
its registry metadata is not bound to `d1f5dea` by a publication receipt; the
commit is not yet remote/tagged; and public npm plus deployment are not claimed.
An external Sigil Chat current-train consumer proof exists. Mirk keeps that
integration evidence with the consumer and does not maintain a cross-project
conformance matrix.

This specification closes those gaps without turning Mirk into a workflow
system, consumer registry, deployment controller, or database product.

The canonical status vocabulary and evidence precedence are defined in the
[root README](../README.md). This specification owns the package contract and
receipt requirements; it does not ratify a release or a cross-project adoption.

## Goals

1. Preserve small, runtime-neutral public ports.
2. Add atomicity as an optional capability with explicit semantics.
3. Make artifact finalization safe for admitted concurrent writers.
4. Make artifact corruption and orphan state inspectable and repairable.
5. Finish fixture authoring and diagnostics without pulling parser bundles into
   the root package.
6. Make SQLite configuration and contention observable.
7. Keep migration resumable, deterministic, and backend-neutral.
8. Make release claims reproducible from package-owned evidence.
9. Keep every adapter honest about unsupported behavior.
10. Keep consumer integration state outside the Mirk repository.

## Non-goals

- A job, workflow, event, inbox, notification, or wake system.
- Provider, worker, retry, cancellation, or progress ownership.
- A list of consuming repositories or supported project versions.
- Product schemas, acceptance policy, canon, attachment, or publication.
- A universal transaction callback that remote backends must fake.
- One physical database for every lifecycle or trust boundary.
- Automatic garbage collection based on inferred product reachability.
- A Mirk-owned client library for every storage vendor.
- A domain migration language or schema inference engine.
- Expanding `@mirk/statements` semantics into the general store ports.

## Ownership boundary

| Concern                     | Mirk owns                                                   | Caller owns                                  |
| --------------------------- | ----------------------------------------------------------- | -------------------------------------------- |
| KV and collection semantics | ports, ordering, filters, versions, conflicts               | domain records and indexes                   |
| Search, vector, graph       | portable query/result contracts                             | embeddings, query policy, graph meaning      |
| Physical topology           | adapter options and declared capabilities                   | selected backend, credentials, deployment    |
| Logical namespaces          | safe binding and isolation                                  | namespace names and lifecycle grouping       |
| Atomic mutation             | conditions, idempotency, conflict results                   | operation meaning and retry decision         |
| Fixtures                    | sources, parsing boundary, validation, layering, provenance | schemas, authored content, materializers     |
| Artifacts                   | bytes, digest, size, metadata, lineage, maintenance         | generation, semantic attachment, approval    |
| Migration                   | copy/checkpoint/verification mechanics                      | transforms, cutover timing, rollback window  |
| Release proof               | package-owned build, test, pack, import evidence            | downstream installation and deployment proof |

## Substrate invariants

### Ports and adapters

- Port subpaths remain free of native bindings and vendor SDKs.
- Source adapters remain explicit imports.
- One source adapter may expose several facets over one connection.
- An adapter implements only capabilities it can satisfy.
- Unsupported behavior fails explicitly; it is not emulated with weaker
  semantics.
- In-memory references are normative implementations, not permissive mocks.

### Sync and async

- Embedded synchronous backends retain synchronous base ports.
- Remote backends implement async ports directly.
- Sync ports may lift to async.
- Async behavior is never projected as synchronous.
- Portable atomic mutation is declarative so remote adapters do not need to run
  arbitrary caller callbacks inside a transaction.

### Namespaces

- Namespaces are logical identifiers, not caller-constructed key prefixes,
  table names, paths, or files.
- A namespace is bound before application code receives a store handle.
- Separate physical stores remain valid for different trust, retention,
  lifecycle, backup, or measured contention boundaries.

### Errors and conflicts

- Missing values, conflicts, unsupported capabilities, transient transport
  failures, integrity failures, and indeterminate outcomes are different typed
  results or typed errors.
- A conflict is not an automatic retry instruction.
- Retryable failures are typed and bounded.
- No adapter reports a successful mutation before its durability point.

### Public safety

- Public records and diagnostics are JSON-safe and secret-free.
- Absolute machine paths are excluded from ordinary diagnostics.
- Root imports remain browser-safe where documented.
- No consumer or private project name appears in public examples, fixtures, or
  package contract tests.

## Current baseline

The following substrate is already present:

- `SyncStore` and `AsyncStore` KV/collection ports;
- optional `listWhereIn` capabilities;
- in-memory and SQLite reference behavior;
- SQLite vector and search facets;
- graph traversal over collections plus optional native traversal;
- libSQL, PostgreSQL, Markdown, and SurrealDB source adapters;
- logical `namespaceStore()` views;
- bounded SQLite busy waits and local synchronous transaction modes;
- fenced keyed async coordination for cooperating external writers;
- fixture memory, store, filesystem, and file-backed package sources;
- fixture validation, layering, patches, references, provenance, and
  materialization;
- artifact object-store and repository ports;
- artifact streaming integrity, idempotency, atomic finalization, object leases,
  lineage, filesystem storage, OpenDAL binding, and plan-first maintenance;
- fixture CLI helpers and the `mirk-fixtures` binary;
- SQLite inspection, explicit checkpoints, and the repository-owned generic
  two-process fault harness; and
- checkpointed migration for stores and caller-provided manifests, including
  plan-bound checkpoint v2, explicit v1 upgrades, and caller-owned verification;
- specialized statement storage with its own independent schema contract.

This specification does not reopen those boundaries. It sequences the remaining
work.

## Workstream A — truthful package and release state

### A1. Reconcile documents with package state

The package manifests, roadmap, package README, and detailed specifications must
agree on:

- implemented source;
- local release bookkeeping;
- named-registry package version;
- public export map; and
- remaining work.

The fixture filesystem and package-resource sources plus the explicit-config
CLI are `implemented`. Optional future source types remain separately gated.
`receipt-green`, registry publication, remote/tagged state, and consumer
adoption are not inferred from source alone.

### A2. Package-owned release evidence

Each affected package release must prove:

1. workspace build;
2. package tests;
3. package typecheck;
4. packed tarball contents;
5. clean installation of the tarball into a temporary generic fixture;
6. import of every public subpath;
7. absence of undeclared workspace or catalog references;
8. absence of private paths, registries, and project names;
9. root-import dependency boundaries; and
10. expected native or vendor dependencies only on adapter subpaths.

The temporary fixture is Mirk-owned and generic. It is not a checkout of a
consuming project.

### A3. Release receipt

CI or the release command should emit an untracked build artifact containing:

```ts
interface MirkSourceState {
  commit: string;
  clean: boolean;
  trackedDiffSha256?: string;
  untrackedInputsSha256?: string;
  packedInputSha256: string;
}

interface MirkReleaseReceipt {
  schema: "mirk-release-receipt/v1";
  source: MirkSourceState;
  package: string;
  version: string;
  tarballSha256: string;
  packedFiles: readonly string[];
  publicExports: readonly string[];
  nodeVersion: string;
  pnpmVersion: string;
  checks: readonly {
    name: string;
    status: "passed" | "failed" | "skipped";
    detail?: string;
  }[];
}
```

`packedInputSha256` is the canonical digest of every source file that can affect
the packed tarball, before packaging. For a dirty local build,
`trackedDiffSha256` covers the tracked diff and `untrackedInputsSha256` covers
untracked files included in the packed inputs.

Rules:

- a publication-mode receipt requires `source.clean: true`;
- a local build receipt may report `source.clean: false`, but it must include
  the applicable dirty-state digests;
- `source.commit` identifies ancestry and never claims that the commit alone
  describes a dirty build;
- every file included in the tarball must be attributable to
  `packedInputSha256`; and
- receipt generation fails when an included input cannot be attributed.

The receipt is package build evidence. It does not claim registry publication,
remote/tagged state, downstream installation, or runtime adoption. Publication
mode additionally requires a clean source tree; it still does not perform or
verify an npm publication.

### A4. Acceptance

- Documentation distinguishes local source implementation, manifest version,
  release/publication evidence, and consumer/runtime adoption.
- A clean tarball fixture imports every public subpath.
- A publication-mode receipt proves a clean source state without claiming
  registry publication.
- A local dirty-build receipt identifies the commit, dirty state, and packed
  input digest without attributing the tree to the commit alone.
- No tracked consumer matrix or downstream status table is introduced.

### A5. Current next gates

The current package-owned closure is `receipt-green`. The remaining gates are
outside the package contract:

1. independent review of this proposed specification;
2. remote merge/tag and explicit provenance for any registry publication,
   distinguishing local Verdaccio from public npm; and
3. a second current-train consumer with its own frozen install and relevant
   runtime evidence.

No new storage category, backend breadth, worktree move, or archive action is
admitted by this specification before those gates are settled. The existing
Sigil Chat proof remains consumer-owned evidence, not a Mirk conformance matrix.

## Workstream B — MR-16 atomic mutation capability

### B1. Design ruling

Do not add transaction, version, or idempotency methods to `SyncStore` or
`AsyncStore`.

Atomicity is an optional capability. Existing stores remain valid.

Do not define the portable contract as an arbitrary callback transaction.
Callback transactions remain useful for embedded adapter-local work, such as
`SqliteAdapter.transaction()`, but cannot be implemented honestly by every
remote backend.

The portable contract is:

- versioned reads;
- explicit preconditions;
- a bounded declarative mutation batch;
- optional idempotency; and
- completed-decision results distinct from typed rejection, backend, and
  indeterminate errors.

Completed atomic decisions return one of:

- `applied`;
- `replayed`;
- `conflict`; or
- `idempotency-conflict`.

Invalid input, unsupported operations, and exceeded limits are rejected before
an atomic decision. A failure that may have happened after commit is
indeterminate and is never returned as an ordinary conflict or backend error.

### B2. Targets and versions

```ts
type StoreTarget =
  | { kind: "key"; key: string }
  | { kind: "record"; collection: string; id: string };

declare const storeVersionBrand: unique symbol;
type StoreVersion = string & { readonly [storeVersionBrand]: true };

interface VersionedStoreValue<T> {
  value: T;
  version: StoreVersion;
}
```

Versions are opaque concurrency tokens:

- callers compare them for equality only;
- adapters may use counters, database row versions, or another stable token
  that satisfies this contract;
- every successful `set` or `put` creates a fresh version, including a write of
  a value identical to the currently stored value;
- versions are write-order tokens, not content hashes;
- deleting and recreating a target must not revive a stale version; and
- version tokens are scoped to one bound store/namespace.

### B3. Versioned read capability

```ts
interface SyncVersionedReadStore {
  getVersioned<T>(target: StoreTarget): VersionedStoreValue<T> | null;
}

interface AsyncVersionedReadStore {
  getVersioned<T>(target: StoreTarget): Promise<VersionedStoreValue<T> | null>;
}
```

The ordinary store ports continue to provide unversioned convenience reads.

### B4. Conditions

```ts
type StoreCondition =
  | { target: StoreTarget; expected: "missing" }
  | { target: StoreTarget; expected: "present" }
  | {
      target: StoreTarget;
      expected: "version";
      version: StoreVersion;
    };
```

Every condition is evaluated at the same atomic decision point as the mutation
batch.

Repeated conditions for the same target are rejected. Conditions are
canonical-sorted by target before evaluation: key targets precede record
targets; keys compare lexically; record targets compare collection first and id
second, both lexically by Unicode code point. When more than one condition would
fail, the result reports the first failed condition in that canonical order.

### B5. Mutation operations

```ts
type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

type JsonObject = { readonly [key: string]: JsonValue };

type AtomicStoreOperation =
  | { op: "set"; key: string; value: JsonValue }
  | { op: "delete"; key: string }
  | {
      op: "put";
      collection: string;
      item: { id: string } & JsonObject;
    }
  | { op: "remove"; collection: string; id: string };
```

Rules:

- operations preserve ordinary store serialization semantics;
- the complete batch commits or none of it commits;
- v1 atomic mutation payloads are JSON-safe values only;
- `undefined`, non-finite numbers, `bigint`, functions, symbols, cyclic values,
  and non-plain objects are `invalid-request` rejections before the decision
  point;
- operation order inside the batch is deterministic;
- repeated targets are rejected in v1 rather than receiving implicit
  last-write-wins behavior;
- an empty batch is rejected;
- every implementation accepts at least 128 conditions, 128 operations, a
  1 MiB canonical encoded request, and a 64 KiB canonical encoded outcome;
- implementations may accept larger requests, but portable callers rely only
  on the required baseline;
- exceeded limits are typed rejections, never partial mutations; and
- the batch cannot contain search, vector, graph-engine, filesystem, object
  storage, network, or application callbacks.

### B6. Idempotency

```ts
interface AtomicIdempotency {
  key: string;
  outcome?: JsonValue;
}
```

Rules:

- `key` is scoped to the bound store namespace;
- the implementation computes `requestDigest`; callers do not supply it;
- the digest input uses the schema tag `mirk-atomic-request/v1`, canonical
  condition order, declared operation order, and the optional outcome;
- canonical JSON sorts object keys lexically, preserves array order, and
  rejects `undefined`, non-finite numbers, `bigint`, functions, symbols, and
  cyclic values;
- `requestDigest` is the lowercase hexadecimal SHA-256 digest of that canonical
  encoding;
- the mutation and its durable receipt commit atomically;
- a receipt is written only for an applied mutation;
- a precondition conflict does not reserve the idempotency key, so the same
  request may be attempted again after state changes;
- repeating the same key and request digest returns the original result;
- reusing the key with a different request digest returns an
  `idempotency-conflict`;
- v1 idempotency receipts do not expire and remain valid for the lifetime of
  the namespace;
- future receipt compaction requires a separately specified namespace epoch or
  tombstone protocol that cannot allow an old key to execute again;
- ordinary writes are not implicitly idempotent; and
- adapters do not retry an indeterminate mutation behind the caller's back.

### B7. Request and result

```ts
interface AtomicMutationRequest {
  conditions?: readonly StoreCondition[];
  operations: readonly AtomicStoreOperation[];
  idempotency?: AtomicIdempotency;
}

type AtomicMutationResult =
  | {
      status: "applied";
      requestDigest: string;
      versions: readonly {
        target: StoreTarget;
        version: StoreVersion | null;
      }[];
      outcome?: JsonValue;
    }
  | {
      status: "replayed";
      requestDigest: string;
      versions: readonly {
        target: StoreTarget;
        version: StoreVersion | null;
      }[];
      outcome?: JsonValue;
    }
  | {
      status: "conflict";
      condition: StoreCondition;
      observed: "missing" | "present" | StoreVersion;
    }
  | {
      status: "idempotency-conflict";
      key: string;
      expectedRequestDigest: string;
      receivedRequestDigest: string;
    };

type AtomicMutationRejectionCode =
  | "invalid-request"
  | "unsupported-operation"
  | "condition-limit-exceeded"
  | "operation-limit-exceeded"
  | "request-size-exceeded"
  | "outcome-size-exceeded";

interface AtomicMutationRejectedError extends Error {
  name: "AtomicMutationRejectedError";
  code: AtomicMutationRejectionCode;
}

interface AtomicMutationBackendError extends Error {
  name: "AtomicMutationBackendError";
  code: "unavailable" | "serialization-failure";
  retryable: boolean;
}

interface AtomicMutationIndeterminateError extends Error {
  name: "AtomicMutationIndeterminateError";
  requestDigest: string;
  idempotencyKey?: string;
  recovery: "retry-with-same-key" | "manual-reconciliation";
}

interface SyncAtomicMutationStore extends SyncVersionedReadStore {
  mutateAtomically(request: AtomicMutationRequest): AtomicMutationResult;
}

interface AsyncAtomicMutationStore extends AsyncVersionedReadStore {
  mutateAtomically(
    request: AtomicMutationRequest
  ): Promise<AtomicMutationResult>;
}
```

The `versions` array contains exactly one entry per distinct operation target,
in declared operation order. `delete` and `remove` return `version: null`.
Condition-only targets are omitted. A replay returns byte-for-byte equivalent
versions and outcome data to the original applied result.

Validation, unsupported operations, and limit failures throw
`AtomicMutationRejectedError` before the decision point. A retryable failure
known to have occurred before any possible commit throws
`AtomicMutationBackendError`. Mutation results are reserved for completed
atomic decisions.

An adapter that can lose its connection after commit but before acknowledgement
must support idempotency or throw `AtomicMutationIndeterminateError`. When an
idempotency key exists, the safe recovery is a retry with the same key and the
same request. Without a key, recovery requires explicit reconciliation. The
adapter must not report an ordinary failure that invites an unsafe blind retry.

### B8. Capability discovery

Capability discovery should use narrow type guards:

```ts
function supportsAtomicMutation(
  store: SyncStore
): store is SyncStore & SyncAtomicMutationStore;

function supportsAsyncAtomicMutation(
  store: AsyncStore
): store is AsyncStore & AsyncAtomicMutationStore;
```

Do not add a broad feature registry to `StoreMeta`.

### B9. Namespace behavior

`namespaceStore()` must preserve atomic capabilities when the underlying store
implements them:

- targets are bound through the namespace wrapper;
- conditions and operations cannot escape the namespace;
- idempotency keys are namespace-scoped;
- versions from one namespace are invalid in another; and
- cross-namespace atomic batches require a separate explicit capability.

V1 does not expose cross-namespace atomic mutation through a namespaced handle.

### B10. Initial implementations

Implemented locally:

1. normative in-memory implementation;
2. SQLite implementation using one transaction and durable idempotency receipt
   table; and
3. namespace wrapper preservation.

Not implemented in this slice:

- PostgreSQL implementation;
- libSQL implementation when its transaction path can meet the contract; and
- SurrealDB implementation when conflict and indeterminate-result semantics are
  proven.

No adapter blocks MR-16 merely because it does not implement the optional
capability.

### B11. Package-owned contract suite

The Mirk atomic-mutation suite must cover:

1. missing and present preconditions;
2. version-match success;
3. stale-version conflict;
4. create-if-missing;
5. delete and recreate invalidating an old version;
6. all-or-nothing multi-operation mutation;
7. deterministic operation ordering;
8. duplicate-target rejection;
9. same-key/same-request replay;
10. same-key/different-request conflict;
11. outcome replay;
12. namespace isolation;
13. reopen persistence;
14. two-process competing CAS with one winner;
15. process termination before commit;
16. process termination after commit with idempotent reconciliation;
17. repeated-condition rejection;
18. canonical first-conflict selection;
19. identical-value write producing a fresh version;
20. exact returned-version membership and ordering;
21. required request and outcome limits;
22. no-expiry receipt persistence; and
23. typed rejection, backend, and indeterminate errors.

This is a Mirk contract suite. It is not a project matrix.

### B12. MR-16 acceptance

- The base store interfaces remain source-compatible.
- In-memory and SQLite pass the package-owned suite.
- Atomic mutations survive close and reopen.
- A two-process competing mutation admits exactly one winner.
- Idempotent replay cannot duplicate a committed batch.
- Namespace wrappers cannot escape their bound namespace.
- Packed root and `/kv` imports remain native-free.

## Workstream C — artifact finalization and maintenance

### C1. Purpose

`@mirk/artifact` already owns immutable bytes, digest, metadata, and lineage.
The local package also implements concurrent finalization and damaged-state
maintenance; capability gates keep unsupported backends explicit.

It does not add execution lifecycle or product attachment semantics.

### C2. Atomic repository capability

The local package adds an optional repository capability:

```ts
interface AtomicArtifactRepository extends ArtifactRepository {
  createIdempotent(input: {
    record: StoredArtifactRecord;
    idempotencyKey: string;
  }): Promise<
    | {
        status: "created";
        requestDigest: string;
        record: StoredArtifactRecord;
      }
    | {
        status: "replayed";
        requestDigest: string;
        record: StoredArtifactRecord;
      }
    | {
        status: "conflict";
        expectedRequestDigest: string;
        receivedRequestDigest: string;
      }
  >;
}
```

The store-backed repository implements this capability when its injected store
implements `AsyncAtomicMutationStore`; otherwise it remains in documented
single-writer mode.

The repository computes the request digest. Callers do not supply it. The digest
uses the `mirk-artifact-finalization/v1` schema tag and the canonical JSON
encoding defined by B6. It includes the artifact digest and every immutable
descriptor field supplied at finalization. Filename and initial annotations
participate when supplied. A later mutable annotation update does not change
the receipt stored for the original finalization request. A replay is compared
against the incoming finalization record, not the record after later mutable
updates.

When the injected store lacks atomic mutation:

- the current single-writer behavior remains available;
- documentation identifies it as single-writer or externally serialized;
- a caller cannot request atomic concurrent finalization; and
- the repository does not claim multi-process idempotency.

### C3. Coordinator concurrency mode

```ts
type ArtifactCoordinatorConcurrency =
  | { mode: "single-writer" }
  | { mode: "repository-atomic" };
```

- `single-writer` preserves existing behavior and requires external exclusion
  for concurrent finalizers.
- `repository-atomic` requires `AtomicArtifactRepository` and fails at
  construction when unavailable.
- Automatic capability guessing is avoided for production configuration.

Artifact finalizers that run through Mirk must also participate in the
repository-owned object lease protocol. Before writing object bytes, a finalizer
acquires a shared writer lease for the candidate immutable object digest and
holds that lease through repository commit, replay, conflict, cleanup, or abort.
Repository record creation must verify that the writer lease is still current in
the same repository decision that creates the record. If the lease was lost, the
finalizer must not create the record.

Destructive repair acquires an exclusive deletion lease for the same object
identity. Acquiring that lease atomically blocks new shared writer leases, checks
that no repository record references the object, and waits for or rejects on any
prior shared writer leases before bytes are inspected or deleted. This is a
cooperative repository protocol, not a claim that the artifact repository and
object store share one transaction.

### C4. Maintenance subpath

The local package exposes an explicit `@mirk/artifact/maintenance` subpath with:

```ts
declare const artifactMaintenanceRefBrand: unique symbol;
type ArtifactMaintenanceRef = string & {
  readonly [artifactMaintenanceRefBrand]: true;
};

interface ArtifactAuditFinding {
  code:
    | "object-without-record"
    | "record-without-object"
    | "size-mismatch"
    | "digest-mismatch"
    | "lineage-missing-source"
    | "lineage-missing-result"
    | "lineage-cycle";
  artifactId?: string;
  maintenanceRef?: ArtifactMaintenanceRef;
  detail?: string;
}

interface ArtifactAuditReport {
  auditId: string;
  scannedRecords: number;
  scannedObjects?: number;
  findings: readonly ArtifactAuditFinding[];
}
```

Rules:

- audit is read-only;
- object enumeration requires `ListableObjectStore`;
- record verification works without object enumeration;
- default output redacts infrastructure paths and credentials;
- findings are deterministic;
- `maintenanceRef` is opaque, scoped to one namespace and audit snapshot, and
  resolvable only by the maintenance implementation;
- `maintenanceRef` cannot be decoded or used as an object-store key by callers;
- `auditId` identifies that snapshot without exposing its namespace or storage
  location;
- object keys never appear in the public finding or repair-plan contract;
- a corrupt object is never silently replaced; and
- absence of listing capability is reported as partial coverage, not success.

### C5. Repair plans

Repair is a two-step operation:

```ts
type ArtifactRepairPrecondition =
  | {
      kind: "object-unreferenced";
      maintenanceRef: ArtifactMaintenanceRef;
      observedDigest?: string;
      observedSizeBytes: number;
      observedEtag?: string;
    }
  | {
      kind: "record-missing-object";
      artifactId: string;
      recordFingerprint: string;
    }
  | {
      kind: "lineage-edge-invalid";
      edgeId: string;
      edgeFingerprint: string;
      expectedReason: "missing-source" | "missing-result" | "cycle";
    }
  | {
      kind: "artifact-descriptor-current";
      artifactId: string;
      descriptorFingerprint: string;
    };

type ArtifactRepairAction =
  | {
      id: string;
      operation: "delete-unreferenced-object";
      precondition: Extract<
        ArtifactRepairPrecondition,
        { kind: "object-unreferenced" }
      >;
    }
  | {
      id: string;
      operation: "delete-record-without-object";
      precondition: Extract<
        ArtifactRepairPrecondition,
        { kind: "record-missing-object" }
      >;
    }
  | {
      id: string;
      operation: "remove-invalid-lineage-edge";
      precondition: Extract<
        ArtifactRepairPrecondition,
        { kind: "lineage-edge-invalid" }
      >;
    }
  | {
      id: string;
      operation: "reverify-imported-object";
      precondition: Extract<
        ArtifactRepairPrecondition,
        { kind: "artifact-descriptor-current" }
      >;
    };

interface ArtifactRepairPlan {
  schema: "mirk-artifact-repair/v1";
  auditId: string;
  createdAt: number;
  actions: readonly ArtifactRepairAction[];
}

type ArtifactRepairApplyResult =
  | { status: "applied"; actionId: string }
  | {
      status: "conflict";
      actionId: string;
      reason:
        | "state-changed"
        | "reference-created"
        | "object-changed"
        | "lease-unavailable";
    }
  | { status: "not-found"; actionId: string };
```

The package generates a plan, but applying it requires an explicit call.
The maintenance implementation, not the caller, computes every maintenance
reference and record, edge, or descriptor fingerprint from its canonical stored
representation. Applying a plan with an unknown or expired `auditId` returns
`not-found`; the implementation never resolves a maintenance reference outside
its originating audit.

Each action is checked and applied independently. For
`delete-unreferenced-object`, the implementation must first acquire an exclusive
deletion lease for the opaque `maintenanceRef`. Lease acquisition is atomic with
the repository no-reference check and with blocking new shared writer leases for
that object identity. If a record already references the object, acquisition
returns `reference-created`.

If older shared writer leases exist, the repair implementation must either wait
for them to end within a bounded maintenance timeout or return
`lease-unavailable`. It must not inspect or delete bytes while a live shared
writer lease can still commit a record for those bytes. After acquiring the
exclusive lease and before deleting bytes, the implementation re-reads the
object and verifies that its digest, size, and available etag still match the
audit. A mismatch releases the lease and returns `object-changed`.

Leases are durable repository records with `leaseId`, owner identity, object
identity, mode, generation, heartbeat time, and bounded expiry. A process that
loses its shared writer lease, observes a generation mismatch, or cannot renew
before expiry must abort finalization and must not commit a repository record.
Repair may reclaim an expired shared writer lease only by atomically advancing
the object lease generation and then rechecking both the no-reference condition
and the object fingerprint before deletion. A crashed repair holding an
exclusive lease is recovered the same way: reclaim the expired lease, advance
generation, and re-read state before any further mutation. Recovery never
continues from a stale pre-expiry observation.

The lease protocol closes only the Mirk-owned finalization path. Direct
repository or object-store writers outside Mirk are out of contract. A backend
that cannot enforce these leases, or an equivalent externally enforced
read-write exclusion protocol, must reject destructive orphan-object repair with
`lease-unavailable`; it must not perform a best-effort cross-store delete.

For the other actions, immediately before mutation the implementation re-reads
the current state and verifies the action's precondition:

- deleting a record requires that the object is still missing and the record
  fingerprint is unchanged;
- removing a lineage edge requires the same edge fingerprint and invalidity
  reason; and
- re-verification requires the same artifact descriptor fingerprint.

A failed precondition returns `conflict` and performs no mutation for that
action. Applying a plan returns one result per action and does not claim that
the complete plan is one transaction.

Allowed initial actions:

- delete a confirmed object-without-record;
- delete a confirmed record-without-object only when the caller explicitly
  chooses metadata removal;
- remove invalid lineage edges; and
- re-verify an imported object.

Disallowed automatic actions:

- recreating missing bytes;
- inventing lineage;
- accepting a new digest for corrupted bytes;
- inferring product reachability;
- deleting based on age; and
- changing product attachments.

### C6. Artifact contract suite

Extend package-owned tests with:

1. concurrent same-key finalization;
2. same finalization request replay;
3. different finalization request conflict;
4. crash after object write before repository commit;
5. cleanup failure reporting;
6. audit of object-without-record;
7. audit of record-without-object;
8. digest and size mismatch;
9. partial audit without list capability;
10. deterministic repair plan;
11. explicit repair application;
12. a newly created reference blocking orphan deletion;
13. forced interleaving where a finalizer has written object bytes under a
    shared lease before repair begins; repair must wait for, block on, or
    recover that lease before deleting, and must not allow a later record for
    missing bytes;
14. forced interleaving where repair acquires an exclusive deletion lease before
    a finalizer writes bytes; the finalizer must fail to acquire or must lose
    its shared lease before repository commit;
15. repair crash after acquiring an exclusive lease and before deletion;
    recovery must reclaim by generation and re-read state before mutation;
16. finalizer crash after object write and before repository commit; repair
    must wait for or reclaim the expired shared lease and recheck state;
17. an object change between audit and repair blocking deletion;
18. a record change between audit and repair blocking deletion;
19. conflict performing no mutation;
20. namespace isolation; and
21. no public exposure of object-store keys.

### C7. Acceptance

- Concurrent artifact finalization is either repository-atomic or explicitly
  single-writer.
- Audit detects every state the coordinator failure protocol can leave behind.
- Repair is plan-first, conditional, and explicit.
- Destructive orphan-object repair uses a repository-owned shared/exclusive
  object lease protocol, an equivalent externally enforced read-write exclusion
  protocol, or is rejected as unsupported.
- Mirk never infers execution success or product acceptance.
- Existing artifact IDs and read paths remain compatible.

## Workstream D — fixture authoring closure

### D1. Scope

The local CLI completes this workstream without changing the root loader
contract.

Commands:

```text
mirk-fixtures validate <config>
mirk-fixtures list <config> [--type <type>]
mirk-fixtures show <config> <type:id> [--raw|--materialized]
mirk-fixtures explain <config> <type:id>
mirk-fixtures graph <config> [--format json|dot]
```

### D2. Configuration

Use an explicit JavaScript module:

```text
mirk.fixtures.mjs
```

It exports the already public loader inputs or a constructed loader:

```js
export default {
  registry,
  sources,
  parsers,
};
```

The CLI does not discover application directories, packages, validators, or
parser plugins implicitly.

Rules:

- configuration resolution is relative to the supplied config path;
- parser packages are imported by the config, not bundled into the root;
- TypeScript configuration is not supported in v1;
- configuration exceptions become structured diagnostics;
- absolute paths are hidden in ordinary output; and
- `--debug-paths` is explicit and intended for local diagnosis only.

### D3. Output

Every command supports:

- human-readable deterministic output; and
- `--json` with a versioned schema.

```ts
interface FixtureCliEnvelope<T> {
  schema: "mirk-fixtures-cli/v1";
  command: string;
  ok: boolean;
  result?: T;
  diagnostics: readonly Diagnostic[];
}
```

Exit codes:

| Code | Meaning                                                     |
| ---- | ----------------------------------------------------------- |
| `0`  | command completed and no error diagnostics exist            |
| `1`  | fixture, reference, parse, schema, or materialization error |
| `2`  | CLI usage or configuration error                            |
| `3`  | source access or unexpected internal failure                |

### D4. Security

- Filesystem and package sources keep their existing realpath containment.
- The CLI never evaluates content as code.
- Only the explicitly supplied configuration module is imported.
- Diagnostics remain path-safe by default.
- Graph output escapes fixture refs and field paths.
- Materialized values are treated as untrusted output.

### D5. Tests

1. deterministic validate output;
2. multi-error aggregation;
3. JSON envelope schema;
4. list filtering;
5. raw and materialized show;
6. provenance explain;
7. unresolved reference graph;
8. DOT escaping;
9. config import failure;
10. parser supplied by config;
11. source read failure;
12. path redaction;
13. debug path opt-in;
14. stable exit codes;
15. packed binary invocation; and
16. root import still excluding Node CLI modules.

### D6. Acceptance

- All five commands operate against memory, filesystem, package, and store
  sources through the same loader.
- No parser library becomes a root dependency.
- JSON output is versioned and deterministic.
- Packed CLI execution works outside the monorepo.

## Workstream E — SQLite concurrency evidence

### E1. Decision

MR-15 and the fenced async coordinator remain implemented foundations. The local
source also implements the MR-17 inspection, checkpoint, and generic evidence
surfaces; the coordinated writer profile remains deferred.

MR-17 does not begin with a writer daemon. The implemented local evidence
slice contains:

1. an operational inspection surface;
2. a generic two-process fault harness;
3. declared workload limits; and
4. evaluation of the existing libSQL adapter.

Consumer projects keep their own application workload tests outside Mirk.

### E2. SQLite inspection

The adapter exposes a read-only inspection method that reports:

```ts
interface SqliteStoreInspection {
  journalMode: string;
  foreignKeys: boolean;
  busyTimeoutMs: number;
  transactionState: "none" | "read" | "write";
  pageCount: number;
  freelistCount: number;
  dataVersion: number;
  walAutocheckpointPages: number;
  walFileSizeBytes?: number;
}
```

The exact fields may vary by `better-sqlite3` and SQLite version. Inspection
must use read-only PRAGMA queries and optional filesystem metadata reads. It
must not invoke any form of `wal_checkpoint`, advance a checkpoint, or otherwise
change database state. Inspection must not leak file paths unless debug output
is requested.

### E3. Explicit checkpoint operation

The adapter exposes an explicit maintenance operation:

```ts
type SqliteCheckpointMode = "passive" | "restart" | "truncate";

interface SqliteCheckpointResult {
  busy: number;
  logFrames: number;
  checkpointedFrames: number;
}
```

Checkpoint calls are explicit infrastructure operations. Ordinary store writes
do not trigger hidden aggressive checkpoints.

### E4. Generic two-process harness

The repository-owned harness uses generated generic records and package tests
exercise it. It proves:

- namespace isolation;
- competing conditional mutations;
- idempotent replay;
- bounded writer waits;
- process kill before commit;
- process kill after commit acknowledgement is withheld;
- close/reopen integrity;
- checkpoint behavior;
- WAL growth bounds; and
- zero silent record loss.

The harness records:

- operation counts;
- applied, replayed, conflicted, failed, and indeterminate outcomes;
- median, p95, p99, and maximum latency;
- busy waits and `SQLITE_BUSY` errors;
- WAL size and checkpoint duration; and
- recovery results for every injected fault point.

Thresholds are defined for the generic harness before the final run. Mirk does
not embed a consuming project's latency budget or traffic profile.

### E5. MR-17 admission gate

A coordinated writer profile proceeds only if:

- a real need remains after MR-16 and the existing coordinator;
- the generic direct-SQLite harness shows an unfixable or operationally
  unacceptable boundary;
- local libSQL cannot satisfy the required profile cleanly;
- the client protocol, authorization, lifecycle, queueing, idempotency,
  readiness, and failure semantics are separately specified; and
- the proposed service is materially smaller than adopting a general
  client/server database.

### E6. Acceptance

- SQLite configuration is inspectable.
- Checkpoint behavior is explicit.
- The two-process harness is exercised in repository tests and is rerun from a
  clean checkout for release evidence.
- No consumer-specific dataset, path, or package is stored in Mirk.
- MR-17 remains deferred unless its admission gate is met.

## Workstream F — migration and adapter admission

### F1. Migration receipts

`@mirk/migrate` now provides plan-bound checkpoints so callers may bind a run to
a stable plan:

```ts
interface MigrationPlanIdentity {
  schema: "mirk-migration-plan/v1";
  planDigest: string;
  sourceIdentity: string;
  destinationIdentity: string;
}

interface MigrationCheckpointV2 {
  plan: MigrationPlanIdentity;
  lane: string;
  processed: number;
  updatedAt: number;
}

interface MigrationCheckpointUpgradeInput {
  checkpoint: MigrationCheckpointV1;
  plan: MigrationPlanIdentity;
  convertedAt: number;
}

function upgradeCheckpointV1(
  input: MigrationCheckpointUpgradeInput
): MigrationCheckpointV2;
```

Rules:

- resume rejects a different plan digest;
- v1 conversion requires the caller to supply the complete plan identity;
- the conversion helper validates the v1 lane and processed count but never
  infers source, destination, or plan digest;
- `convertedAt` is explicitly the conversion time, not a claim about when the
  original v1 checkpoint was written;
- manifest ordering remains caller-owned and deterministic;
- checkpoints do not imply destination verification;
- source deletion is outside the package;
- transforms remain caller-owned; and
- non-KV enumeration remains manifest-driven.

### F2. Verification callback

Migration helpers accept a generic post-copy verifier:

```ts
interface MigrationVerification {
  ok: boolean;
  checked: number;
  diagnostics: readonly {
    code: string;
    message: string;
    locator?: string;
  }[];
}
```

The caller supplies domain-free exported entries or checks. Mirk does not
import a consumer schema.

### F3. Adapter admission

A new adapter or facet enters the roadmap only when:

1. it implements an existing port;
2. a current port cannot satisfy the motivating workload through an admitted
   adapter;
3. the backend has a maintained upstream client;
4. optional dependencies remain isolated to the adapter subpath;
5. unsupported semantics are named before implementation;
6. the adapter passes the relevant Mirk contract suite;
7. reopen, fault, and cleanup behavior are tested; and
8. operational configuration is explicit.

The motivating consumer belongs in the issue or external proposal that
requested the work. It does not become a tracked compatibility row in Mirk.

### F4. Deferred adapter work

The following remain deferred:

- Qdrant vector adapter;
- PostgreSQL full-text search;
- PostgreSQL pgvector;
- persistent SurrealDB browser WASM until the fixed upstream release passes
  write/reopen/read; and
- any inbox or append-log package without a smaller storage-only contract.

### F5. Specialized packages

`@mirk/statements` remains a specialized persistence package:

- it may use general Mirk store and coordination capabilities;
- it may provide evidence for a reusable primitive;
- it does not expand the base store contract merely because its schema needs a
  feature; and
- its domain-shaped storage schema remains separately versioned.

## Delivery order

### Phase 0 — documentation and release truth

1. Resolve blocking review comments and approve this specification.
2. Correct fixture status in roadmap and package docs — implemented locally.
3. Add or confirm packed-package generic fixture checks — implemented locally.
4. Define the release receipt schema and CI artifact — implemented locally.

### Phase 1 — atomic mutation

1. Freeze target, version, condition, operation, idempotency, and result types — implemented locally.
2. Implement the in-memory reference — implemented locally.
3. Add the package-owned contract suite — implemented locally.
4. Implement SQLite — implemented locally.
5. Preserve capability through namespace wrappers — implemented locally.
6. Run the generic two-process CAS/idempotency harness — implemented locally.
7. Keep the capability optional in `@mirk/store`; publication and adoption are separate evidence.

### Phase 2 — artifact hardening

1. Implement `AtomicArtifactRepository` over atomic stores — implemented locally.
2. Add explicit coordinator concurrency mode — implemented locally.
3. Add read-only audit — implemented locally.
4. Add plan-first repair — implemented locally.
5. Run crash and concurrent-finalization tests — implemented locally.

### Phase 3 — fixture CLI

1. Freeze configuration and JSON envelope — implemented locally.
2. Implement commands and exit codes — implemented locally.
3. Add packed-binary tests — implemented locally.
4. Keep the CLI behind its explicit Node subpath and binary; publication and adoption are separate evidence.

### Phase 4 — concurrency operations

1. Add SQLite inspection — implemented locally.
2. Add explicit checkpoint operation — implemented locally.
3. Complete the generic fault harness — implemented locally.
4. Evaluate local libSQL before admitting a coordinated profile.
5. Keep MR-17 deferred unless the admission gate requires a separate service specification.

### Phase 5 — migration receipts

1. Add plan-bound checkpoints — implemented locally.
2. Add generic verification callbacks — implemented locally.
3. Preserve v1 checkpoint compatibility through an explicit adapter — implemented locally.

## Test and verification strategy

### Required command gates

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm test
pnpm -r typecheck
```

Database packages also run their real-backend suites when the required service
is available. A skipped external-backend test is reported as skipped, never
passed.

### Package contract suites

Contract suites are organized by Mirk surface:

- KV and collection;
- optional IN query;
- search;
- vector;
- graph traversal;
- atomic mutation;
- object store;
- artifact repository and coordinator;
- fixture source and loader;
- migration helper; and
- adapter-specific lifecycle.

An adapter's package states which suites it implements. Mirk does not state
which projects currently consume it.

### Packed-package verification

At least one clean temporary fixture must prove:

- public export resolution;
- runtime-neutral root imports;
- declared optional peer behavior;
- built JavaScript rather than raw TypeScript;
- ESM-only behavior;
- public type declarations; and
- no workspace-only dependency resolution.

## Compatibility and migration

- Existing `SyncStore` and `AsyncStore` implementations remain valid.
- Atomic mutation is additive and optional.
- Existing `SqliteAdapter.transaction()` remains available.
- Existing artifact repositories default to their documented single-writer
  behavior.
- Artifact atomic concurrency is opt-in and capability-checked.
- Fixture loader APIs remain unchanged.
- Fixture CLI is a new subpath and binary.
- Migration checkpoint v1 remains readable only through an explicit conversion
  supplied with plan identity and conversion time.
- No existing adapter is removed for lacking a new optional capability.

## Security requirements

- Atomic request digests contain no secrets.
- Mutation outcomes stored for replay are bounded and JSON-safe.
- Version tokens reveal no database credentials or physical keys.
- Artifact audit does not expose storage roots or credentials.
- Repair never runs implicitly after audit.
- Fixture CLI configuration is explicit; authored data is never executed.
- Migration identities avoid embedding credentials.
- Adapter diagnostics redact connection strings and absolute paths.

## Stop conditions

Stop or split the work if:

- a proposal adds project names or downstream compatibility state to Mirk;
- an optional capability is added to the base store interfaces;
- an async backend is forced through a synchronous API;
- a remote backend must execute an arbitrary caller transaction callback;
- a transaction is simulated by sequential independent writes;
- an adapter silently weakens conditional write semantics;
- artifact finalization is called atomic over a non-atomic repository;
- audit automatically deletes or rewrites data;
- fixture CLI pulls parser bundles into the root package;
- MR-17 begins with a daemon before generic evidence and libSQL evaluation;
- a new adapter exists mainly because it is fashionable or conceptually
  adjacent;
- package checks pass only through workspace links; or
- documentation calls an external consumer green.

## Definition of done

This substrate program is complete when:

- package status and release evidence are internally consistent;
- `@mirk/store` exposes optional portable atomic mutation;
- in-memory and SQLite pass the Mirk-owned atomic suite;
- namespaces preserve atomic isolation;
- artifact finalization is explicit about single-writer versus atomic mode;
- artifact audit and plan-first repair cover coordinator failure residue;
- the fixture CLI ships with deterministic human and JSON output;
- SQLite configuration and checkpoints are inspectable;
- a generic two-process harness proves conflict, idempotency, crash, reopen, and
  checkpoint behavior;
- migration checkpoints bind to a stable plan;
- no new backend breadth was added without admission evidence;
- root imports remain dependency-light and code-split; and
- Mirk contains no cross-project conformance matrix.

## Resolved decisions

1. Atomic mutation types live at `@mirk/store/atomic`, with explicit root and
   `/kv` capability re-exports. The capability is optional and does not widen
   the base store ports.
2. Artifact maintenance lives at `@mirk/artifact/maintenance` and is plan-first,
   conditional, and explicit.
3. The fixture CLI accepts either a constructed loader or loader inputs exported
   by `mirk.fixtures.mjs`; both forms normalize through one path.
4. Migration checkpoint v2 is additive. Existing v1 checkpoints remain usable
   through an explicit caller-bound upgrade helper.
5. SQLite inspection and checkpoints are methods on `SqliteAdapter`; the
   repository harness remains test/tooling code rather than a public export.

## Remaining decisions

1. Whether replayed idempotency outcomes need an explicit codec after v1. Keep
   the v1 contract JSON-safe and add codecs only if binary or richer outcomes
   are proven.
2. Whether a future CLI version should add another explicit configuration shape.
3. Whether a coordinated MR-17 writer profile is justified after generic
   evidence and backend evaluation. A writer daemon is not assumed.
