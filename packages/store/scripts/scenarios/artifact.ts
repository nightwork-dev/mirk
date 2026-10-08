import {
  defineScenario,
  type AuthoredStep,
} from "../../src/conformance/define.js";

const check = (op: string, ...args: unknown[]): AuthoredStep => ({
  op,
  args,
  expect: { value: true },
});
const reject = (op: string, ...args: unknown[]): AuthoredStep => ({
  op,
  args,
  expect: { throws: true },
});
const step = (op: string, ...args: unknown[]): AuthoredStep => ({ op, args });
const text = (value: string) => Buffer.from(value, "utf8").toString("base64");
const document = (extra: Record<string, unknown> = {}) => ({
  bytes: text("hello"),
  mediaType: "text/plain",
  ...extra,
});
const scenario = (
  name: string,
  steps: AuthoredStep[],
  config: Record<string, unknown> = {}
) =>
  defineScenario({
    id: `artifact/lifecycle/${name}`,
    title: name.replaceAll("-", " "),
    ports: ["artifact"],
    steps: [step("configure", config), ...steps],
  });
const record = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  objectKey: `artifacts/${id}`,
  createdAt: 1_000,
  mediaType: "text/plain",
  sizeBytes: 5,
  digest: {
    algorithm: "sha256",
    value: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
  },
  ...extra,
});
const leaseInput = {
  objectKey: "orphan",
  ownerId: "writer",
  mode: "shared-writer",
  ttlMs: 10,
};
const lease = {
  leaseId: "lease-1",
  objectKey: "orphan",
  ownerId: "writer",
  mode: "shared-writer",
  generation: 0,
  heartbeatAt: 1_000,
  expiresAt: 1_010,
};

export const scenarios = [
  scenario("write-read-verify", [
    check("write", document()),
    check("read", "artifact-1"),
    check("verify", "artifact-1"),
    check("get", "artifact-1"),
  ]),
  scenario("empty-bytes", [
    check("write", document({ bytes: "" })),
    check("read", "artifact-1"),
    check("verify", "artifact-1"),
  ]),
  scenario("binary-bytes", [
    check(
      "write",
      document({ bytes: "AAECf4D/", mediaType: "application/octet-stream" })
    ),
    check("read", "artifact-1"),
  ]),
  scenario("portable-metadata", [
    check(
      "write",
      document({
        filename: "notes.txt",
        kind: "document",
        producer: { system: "test", operation: "render" },
        annotations: { title: "Résumé", empty: null },
      })
    ),
    check("get", "artifact-1"),
  ]),
  scenario("invalid-media-type", [
    reject("write", document({ mediaType: "invalid" })),
    check("list"),
  ]),
  scenario("empty-producer", [
    reject("write", document({ producer: { system: " " } })),
    check("list"),
  ]),
  scenario("non-string-producer-system", [
    reject("write", document({ producer: { system: 17 } })),
    check("list"),
  ]),
  scenario("missing-read-and-delete", [
    check("read", "missing"),
    check("delete", "missing"),
    reject("verify", "missing"),
  ]),
  scenario("delete-record-and-bytes", [
    step("write", document()),
    check("delete", "artifact-1"),
    check("read", "artifact-1"),
    check("audit"),
  ]),
  scenario("idempotent-replay", [
    check("write", document({ idempotencyKey: "request" })),
    check("write", document({ idempotencyKey: "request" })),
    check("list"),
  ]),
  scenario("replay-after-record-delete", [
    step("write", document({ idempotencyKey: "request" })),
    step("delete", "artifact-1"),
    reject("write", document({ idempotencyKey: "request" })),
    check("list"),
  ]),
  scenario("idempotent-different-bytes", [
    step("write", document({ idempotencyKey: "request" })),
    reject(
      "write",
      document({ bytes: text("other"), idempotencyKey: "request" })
    ),
    check("read", "artifact-1"),
  ]),
  scenario("idempotent-different-metadata", [
    step("write", document({ idempotencyKey: "request" })),
    reject(
      "write",
      document({ mediaType: "text/markdown", idempotencyKey: "request" })
    ),
    check("list"),
  ]),
  scenario(
    "idempotency-key-encoding",
    [
      step("write", document({ idempotencyKey: "a:b/é" })),
      check("get", "artifact-1"),
    ],
    { namespace: "document space" }
  ),
  scenario("annotation-null-is-a-value", [
    step("write", document({ annotations: { a: 1 } })),
    check("updateAnnotations", "artifact-1", { a: null, b: "new" }),
    check("read", "artifact-1"),
  ]),
  scenario("annotation-removal", [
    step("write", document({ annotations: { a: 1 } })),
    check("removeAnnotations", "artifact-1", ["a"]),
    check("get", "artifact-1"),
  ]),
  scenario("replay-after-annotation-update", [
    step(
      "write",
      document({ annotations: { a: 1 }, idempotencyKey: "request" })
    ),
    step("updateAnnotations", "artifact-1", { a: 2 }),
    check(
      "write",
      document({ annotations: { a: 1 }, idempotencyKey: "request" })
    ),
  ]),
  scenario("missing-annotation-target", [
    reject("updateAnnotations", "missing", { a: 1 }),
  ]),
  scenario("list-order-and-cursor", [
    step("write", document()),
    step("write", document()),
    check("list", { limit: 1 }),
    check("list", { limit: 1, cursor: "1000:artifact-2" }),
    reject("list", { cursor: "bad" }),
  ]),
  scenario(
    "code-point-order",
    [step("write", document()), step("write", document()), check("list")],
    { ids: ["\u{1f600}", "\ufffd"] }
  ),
  scenario("list-time-bounds", [
    step("write", document()),
    step("setTime", 2_000),
    step("write", document()),
    check("list", { createdAfter: 1_000 }),
    check("list", { createdBefore: 2_000 }),
  ]),
  scenario("list-metadata-filters", [
    step(
      "write",
      document({
        kind: "source",
        producer: {
          system: "test",
          jobId: "job",
          attemptId: "attempt",
          outputSlot: "text",
        },
      })
    ),
    step("write", document({ mediaType: "application/json" })),
    check("list", {
      mediaTypePrefix: "text/",
      kind: "source",
      producerSystem: "test",
      producerJobId: "job",
      producerAttemptId: "attempt",
      producerOutputSlot: "text",
    }),
    check("list", { mediaType: "application/json" }),
  ]),
  scenario("digest-lookup", [
    step("write", document()),
    step("write", document()),
    check("getByDigest", record("x").digest),
  ]),
  scenario("lineage-write-and-traverse", [
    step("write", document()),
    check(
      "write",
      document({
        sources: [
          {
            artifactId: "artifact-1",
            operation: "copy",
            parameters: { quality: 1 },
          },
        ],
      })
    ),
    check("getSources", "artifact-2"),
    check("getDerivatives", "artifact-1"),
  ]),
  scenario("lineage-missing-source-rolls-back", [
    reject(
      "write",
      document({ sources: [{ artifactId: "missing", operation: "copy" }] })
    ),
    check("list"),
    check("audit"),
  ]),
  scenario("lineage-self-cycle", [
    step("write", document()),
    reject("addLineage", {
      id: "edge",
      sourceArtifactId: "artifact-1",
      resultArtifactId: "artifact-1",
      operation: "copy",
      createdAt: 1_000,
    }),
    check("getSources", "artifact-1"),
  ]),
  scenario("lineage-cycle", [
    step("write", document()),
    step(
      "write",
      document({ sources: [{ artifactId: "artifact-1", operation: "copy" }] })
    ),
    reject("addLineage", {
      id: "reverse",
      sourceArtifactId: "artifact-2",
      resultArtifactId: "artifact-1",
      operation: "copy",
      createdAt: 1_000,
    }),
  ]),
  scenario("delete-removes-lineage", [
    step("write", document()),
    step(
      "write",
      document({ sources: [{ artifactId: "artifact-1", operation: "copy" }] })
    ),
    step("delete", "artifact-1"),
    check("getSources", "artifact-2"),
    check("verify", "artifact-2"),
  ]),
  scenario("import-existing-object", [
    step("putObject", "external/source", text("hello")),
    check("importArtifact", {
      objectKey: "external/source",
      mediaType: "text/plain",
    }),
    check("read", "artifact-1"),
  ]),
  scenario("import-missing-object", [
    reject("importArtifact", { objectKey: "missing", mediaType: "text/plain" }),
    check("list"),
  ]),
  scenario("shared-object-deletion", [
    step("putObject", "shared", text("hello")),
    step("importArtifact", { objectKey: "shared", mediaType: "text/plain" }),
    step("importArtifact", { objectKey: "shared", mediaType: "text/plain" }),
    check("delete", "artifact-1"),
    check("read", "artifact-2"),
    check("delete", "artifact-2"),
    check("audit"),
  ]),
  scenario("verify-missing-object", [
    step("write", document()),
    step("deleteObject", "artifacts/artifact-1"),
    check("verify", "artifact-1"),
    reject("read", "artifact-1"),
  ]),
  scenario("verify-digest-mismatch", [
    step("write", document()),
    step("putObject", "artifacts/artifact-1", text("other")),
    check("verify", "artifact-1"),
  ]),
  scenario("verify-size-mismatch", [
    step("write", document()),
    step("putObject", "artifacts/artifact-1", text("longer")),
    check("verify", "artifact-1"),
  ]),
  scenario("audit-and-repair-orphan", [
    step("putObject", "orphan", text("orphan")),
    check("audit"),
    check("planRepair"),
    check("applyRepair"),
    check("audit"),
  ]),
  scenario("repair-changed-orphan-conflicts", [
    step("putObject", "orphan", text("before")),
    step("audit"),
    step("planRepair"),
    step("putObject", "orphan", text("after")),
    check("applyRepair"),
    check("audit"),
  ]),
  scenario("repair-new-reference-conflicts", [
    step("putObject", "orphan", text("hello")),
    step("audit"),
    step("planRepair"),
    step("importArtifact", { objectKey: "orphan", mediaType: "text/plain" }),
    check("applyRepair"),
    check("read", "artifact-1"),
  ]),
  scenario("repair-missing-object-record", [
    step("write", document()),
    step("deleteObject", "artifacts/artifact-1"),
    check("audit"),
    check("planRepair"),
    check("applyRepair"),
    check("list"),
  ]),
  scenario("repair-record-change-conflicts", [
    step("write", document()),
    step("deleteObject", "artifacts/artifact-1"),
    step("audit"),
    step("planRepair"),
    step("updateAnnotations", "artifact-1", { changed: true }),
    check("applyRepair"),
    check("get", "artifact-1"),
  ]),
  scenario("repair-blocked-by-writer", [
    step("putObject", "orphan", text("hello")),
    step("audit"),
    step("planRepair"),
    step("acquireObjectLease", leaseInput),
    check("applyRepair"),
  ]),
  scenario("shared-leases-exclude-delete", [
    check("acquireObjectLease", leaseInput),
    check("acquireObjectLease", { ...leaseInput, ownerId: "other" }),
    check("acquireObjectLease", {
      ...leaseInput,
      ownerId: "repair",
      mode: "exclusive-delete",
    }),
  ]),
  scenario("exclusive-lease-excludes-writers", [
    check("acquireObjectLease", { ...leaseInput, mode: "exclusive-delete" }),
    check("acquireObjectLease", { ...leaseInput, ownerId: "other" }),
  ]),
  scenario("lease-renew-and-release", [
    step("acquireObjectLease", leaseInput),
    step("setTime", 1_005),
    check("renewObjectLease", { ...lease, ttlMs: 20 }),
    check("releaseObjectLease", lease),
    check("releaseObjectLease", lease),
  ]),
  scenario("lease-wrong-owner", [
    step("acquireObjectLease", leaseInput),
    check("releaseObjectLease", { ...lease, ownerId: "other" }),
    check("renewObjectLease", { ...lease, ownerId: "other" }),
  ]),
  scenario("lease-must-match-committed-object", [
    step("acquireObjectLease", leaseInput),
    step("acquireObjectLease", {
      objectKey: "other",
      ownerId: "repair",
      mode: "exclusive-delete",
    }),
    check("createWithLease", {
      lease,
      record: record("wrong", { objectKey: "other" }),
    }),
    check("get", "wrong"),
    check("list"),
  ]),
  scenario("idempotent-lease-must-match-committed-object", [
    step("acquireObjectLease", leaseInput),
    step("acquireObjectLease", {
      objectKey: "other",
      ownerId: "repair",
      mode: "exclusive-delete",
    }),
    check("createIdempotentWithLease", {
      lease,
      record: record("wrong", { objectKey: "other" }),
      idempotencyKey: "key",
    }),
    check("getByIdempotencyKey", "key"),
    check("list"),
  ]),
  scenario("direct-delete-retains-bytes-during-write", [
    step("write", document()),
    step("acquireObjectLease", {
      objectKey: "artifacts/artifact-1",
      ownerId: "other",
      mode: "shared-writer",
    }),
    reject("delete", "artifact-1"),
    check("get", "artifact-1"),
    check("audit"),
    step("planRepair"),
    check("applyRepair"),
  ]),
  scenario("lease-expiry-advances-generation", [
    step("acquireObjectLease", leaseInput),
    step("setTime", 1_011),
    check("acquireObjectLease", { ...leaseInput, ownerId: "other" }),
    check("renewObjectLease", lease),
    check("createWithLease", {
      lease,
      record: record("lost", { objectKey: "orphan" }),
    }),
    check("list"),
  ]),
  scenario("referenced-object-excludes-delete-lease", [
    step("write", document()),
    check("acquireObjectLease", {
      objectKey: "artifacts/artifact-1",
      ownerId: "repair",
      mode: "exclusive-delete",
    }),
  ]),
  scenario("atomic-create-replay-conflict", [
    check("createIdempotent", {
      record: record("first"),
      idempotencyKey: "key",
    }),
    check("createIdempotent", {
      record: record("second"),
      idempotencyKey: "key",
    }),
    check("createIdempotent", {
      record: record("third", { mediaType: "text/markdown" }),
      idempotencyKey: "key",
    }),
  ]),
  scenario("metadata-fingerprint", [
    check("metadataFingerprint", { z: 1, a: { "\u{1f600}": 2, "\ufffd": 3 } }),
  ]),
  scenario("finalization-digest-excludes-storage-identity", [
    check("finalizationDigest", record("one", { annotations: { a: 1 } })),
    check(
      "finalizationDigest",
      record("two", { createdAt: 2_000, annotations: { a: 1 } })
    ),
    check("finalizationDigest", record("one", { annotations: { a: 2 } })),
  ]),
];
