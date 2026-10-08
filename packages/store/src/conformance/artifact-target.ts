import {
  ArtifactCoordinator,
  ArtifactMaintenance,
  InMemoryArtifactRepository,
  InMemoryObjectStore,
  artifactFinalizationDigest,
  type ArtifactAuditReport,
  type ArtifactRepairPlan,
  type ArtifactRepository,
  type ArtifactCoordinatorConcurrency,
  type WriteArtifactInput,
} from "@mirk/artifact";
import { StoreArtifactRepository } from "@mirk/artifact/store";
import { canonicalDigest, toAsync, type SyncStore } from "../index.js";

type Config = {
  ids?: string[];
  now?: number;
  namespace?: string;
  concurrency?: ArtifactCoordinatorConcurrency;
};

/** Corpus-only adapter. Production store entry points never import this module. */
export function artifactApi(
  backend: "memory" | "sqlite",
  store: SyncStore
): Record<string, unknown> {
  let clock = 1_000;
  let objects: InMemoryObjectStore;
  let repository: InMemoryArtifactRepository | StoreArtifactRepository;
  let coordinator: ArtifactCoordinator;
  let maintenance: ArtifactMaintenance;
  let report: ArtifactAuditReport | undefined;
  let plan: ArtifactRepairPlan | undefined;

  const configure = (config: Config = {}): void => {
    clock = config.now ?? 1_000;
    let id = 0;
    let lease = 0;
    let audit = 0;
    const now = () => clock;
    const leaseIdFactory = () => `lease-${++lease}`;
    objects = new InMemoryObjectStore();
    repository =
      backend === "memory"
        ? new InMemoryArtifactRepository({ now, leaseIdFactory })
        : new StoreArtifactRepository(toAsync(store), { now, leaseIdFactory });
    coordinator = new ArtifactCoordinator(objects, repository, {
      namespace: config.namespace ?? "artifacts",
      idFactory: () => {
        const index = id++;
        return config.ids?.[index] ?? `artifact-${index + 1}`;
      },
      now,
      ownerId: "conformance-writer",
      concurrency: config.concurrency ?? { mode: "repository-atomic" },
    });
    maintenance = new ArtifactMaintenance(objects, repository, {
      now,
      ownerId: "conformance-maintenance",
      auditIdFactory: () => `audit-${++audit}`,
    });
    report = undefined;
    plan = undefined;
  };
  configure();

  return {
    configure,
    setTime: (value: number) => {
      clock = value;
    },
    write: (input: Omit<WriteArtifactInput, "bytes"> & { bytes: string }) =>
      coordinator.write({
        ...input,
        bytes: Buffer.from(input.bytes, "base64"),
      }),
    importArtifact: (input: Parameters<ArtifactCoordinator["import"]>[0]) =>
      coordinator.import(input),
    async read(id: string) {
      const result = await coordinator.read(id);
      if (!result) return null;
      const parts: Uint8Array[] = [];
      for await (const chunk of result.bytes) parts.push(chunk);
      return {
        artifact: result.artifact,
        bytes: Buffer.concat(parts).toString("base64"),
      };
    },
    verify: (id: string) => coordinator.verify(id),
    delete: (id: string) => coordinator.delete(id),
    get: (id: string) => repository.get(id),
    list: (query: Parameters<ArtifactRepository["list"]>[0] = {}) =>
      repository.list(query),
    updateAnnotations: (
      id: string,
      patch: Parameters<ArtifactRepository["updateAnnotations"]>[1]
    ) => repository.updateAnnotations(id, patch),
    removeAnnotations: (id: string, keys: string[]) =>
      repository.updateAnnotations(
        id,
        Object.fromEntries(keys.map((key) => [key, undefined]))
      ),
    getSources: (id: string) => repository.getSources(id),
    getDerivatives: (id: string) => repository.getDerivatives(id),
    getByDigest: (digest: Parameters<ArtifactRepository["getByDigest"]>[0]) =>
      repository.getByDigest(digest),
    getByIdempotencyKey: (key: string) => repository.getByIdempotencyKey(key),
    addLineage: (edge: Parameters<ArtifactRepository["addLineage"]>[0]) =>
      repository.addLineage(edge),
    createRecord: (record: Parameters<ArtifactRepository["create"]>[0]) =>
      repository.create(record),
    removeLineage: (id: string) => repository.removeLineage(id),
    acquireObjectLease: (
      input: Parameters<InMemoryArtifactRepository["acquireObjectLease"]>[0]
    ) => repository.acquireObjectLease(input),
    renewObjectLease: (
      input: Parameters<InMemoryArtifactRepository["renewObjectLease"]>[0]
    ) => repository.renewObjectLease(input),
    releaseObjectLease: (
      input: Parameters<InMemoryArtifactRepository["releaseObjectLease"]>[0]
    ) => repository.releaseObjectLease(input),
    createWithLease: (
      input: Parameters<InMemoryArtifactRepository["createWithLease"]>[0]
    ) => repository.createWithLease(input),
    createIdempotent: (
      input: Parameters<InMemoryArtifactRepository["createIdempotent"]>[0]
    ) => repository.createIdempotent(input),
    createIdempotentWithLease: (
      input: Parameters<
        InMemoryArtifactRepository["createIdempotentWithLease"]
      >[0]
    ) => repository.createIdempotentWithLease(input),
    async putObject(key: string, bytes: string) {
      await objects.put(key, Buffer.from(bytes, "base64"));
    },
    deleteObject: (key: string) => objects.delete(key),
    async audit() {
      report = await maintenance.audit();
      return report;
    },
    async planRepair() {
      if (!report) throw new Error("audit must run before planRepair");
      plan = await maintenance.planRepair(report);
      return plan;
    },
    async applyRepair() {
      if (!plan) throw new Error("planRepair must run before applyRepair");
      return maintenance.applyRepair(plan);
    },
    metadataFingerprint: canonicalDigest,
    finalizationDigest: artifactFinalizationDigest,
  };
}
