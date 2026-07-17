import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import type { ArtifactDescriptor, ArtifactDigest, ArtifactProducer, ByteSource, ByteStream, JsonValue, StoredArtifactRecord } from "./types.js";

export async function* chunks(source: ByteSource): ByteStream {
  if (source instanceof Uint8Array) {
    yield source;
    return;
  }
  for await (const chunk of source) {
    if (!(chunk instanceof Uint8Array)) throw new TypeError("artifact byte sources must yield Uint8Array chunks");
    yield chunk;
  }
}

export function hashingStream(source: ByteSource, complete: (digest: ArtifactDigest, sizeBytes: number) => void): ByteStream {
  return (async function* () {
    const hash = sha256.create();
    let sizeBytes = 0;
    for await (const chunk of chunks(source)) {
      hash.update(chunk);
      sizeBytes += chunk.byteLength;
      yield chunk;
    }
    complete({ algorithm: "sha256", value: bytesToHex(hash.digest()) }, sizeBytes);
  })();
}

export async function digestStream(source: ByteSource): Promise<{ digest: ArtifactDigest; sizeBytes: number }> {
  const hash = sha256.create();
  let sizeBytes = 0;
  for await (const chunk of chunks(source)) {
    hash.update(chunk);
    sizeBytes += chunk.byteLength;
  }
  return { digest: { algorithm: "sha256", value: bytesToHex(hash.digest()) }, sizeBytes };
}

export function assertObjectKey(key: string): void {
  if (!key || key.includes("\0") || key.startsWith("/") || key.split("/").some((part) => part === ".." || part === ".")) {
    throw new TypeError(`invalid object key: ${JSON.stringify(key)}`);
  }
}

export function assertPortableMetadata(input: { mediaType: string; annotations?: Record<string, JsonValue>; producer?: ArtifactProducer }): void {
  if (!input.mediaType.trim() || !input.mediaType.includes("/")) throw new TypeError("mediaType must be a non-empty MIME type");
  if (input.producer && !input.producer.system.trim()) throw new TypeError("producer.system must be non-empty");
  if (input.annotations) assertBoundedJson(input.annotations, "annotations");
}

export function assertBoundedJson(value: JsonValue, label: string): void {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new TypeError(`${label} must be JSON-safe`);
  if (utf8ToBytes(serialized).byteLength > 64 * 1024) throw new RangeError(`${label} exceeds 64 KiB`);
  visitJson(value, 0, label);
}

function visitJson(value: JsonValue, depth: number, label: string): void {
  if (depth > 20) throw new RangeError(`${label} exceeds maximum depth 20`);
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`${label} contains a non-finite number`);
    return;
  }
  for (const child of Array.isArray(value) ? value : Object.values(value)) visitJson(child, depth + 1, label);
}

export function descriptor(record: StoredArtifactRecord): ArtifactDescriptor {
  const { objectKey: _objectKey, idempotencyKey: _key, idempotencyFingerprint: _fingerprint, ...portable } = record;
  return portable;
}

export function metadataFingerprint(input: unknown): string {
  const stable = stableJson(input);
  return bytesToHex(sha256(utf8ToBytes(stable)));
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function makeId(): string {
  const cryptoApi = (globalThis as { crypto?: { randomUUID?: () => string; getRandomValues?: (bytes: Uint8Array) => Uint8Array } }).crypto;
  if (cryptoApi?.randomUUID) return cryptoApi.randomUUID();
  if (!cryptoApi?.getRandomValues) throw new Error("artifact IDs require Web Crypto or an injected idFactory");
  const bytes = cryptoApi.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytesToHex(bytes);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
