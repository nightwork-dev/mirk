import { describe, expect, it } from "vitest";

import { InMemoryKv } from "./kv.js";
import {
  ENCRYPTED_RECORD_PURPOSE,
  ENCRYPTED_RECORD_SUITE,
  EncryptedRecordError,
  openEncryptedRecord,
  sealEncryptedRecord,
  validateEncryptedRecordEnvelope,
  type EncryptedRecordContext,
  type EncryptedRecordEnvelope,
} from "./encrypted.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const context: EncryptedRecordContext = {
  tenantScope: "tenant:example",
  vaultId: "vault:private-profile",
  recordId: "conversation:welcome",
  revisionId: "rev:0001",
};

function key(fill: number): Uint8Array {
  return new Uint8Array(32).fill(fill);
}

function bytes(text: string): Uint8Array {
  return encoder.encode(text);
}

async function expectEncryptedRecordError(
  action: () => Promise<unknown> | unknown,
  code: EncryptedRecordError["code"],
): Promise<void> {
  try {
    await action();
  } catch (error) {
    expect(error).toBeInstanceOf(EncryptedRecordError);
    expect((error as EncryptedRecordError).code).toBe(code);
    return;
  }
  throw new Error(`expected EncryptedRecordError ${code}`);
}

describe("encrypted records", () => {
  it("seals a record, persists the JSON envelope, reopens it, and hides plaintext from storage", async () => {
    const store = new InMemoryKv();
    const plaintext =
      "Private profile note: this text stays private until the client opens it.";
    const envelope = await sealEncryptedRecord(context, bytes(plaintext), key(7), "epoch:alpha");

    store.set("encrypted-records/conversation:welcome/rev:0001", envelope);
    const reopened = store.get<EncryptedRecordEnvelope>(
      "encrypted-records/conversation:welcome/rev:0001",
    );

    expect(reopened).not.toBeNull();
    expect(JSON.stringify(reopened)).not.toContain("Private profile note");
    await expect(
      openEncryptedRecord(context, reopened as EncryptedRecordEnvelope, key(7)),
    ).resolves.toEqual(bytes(plaintext));
  });

  it("uses a fresh nonce for each seal while keeping the same authenticated context", async () => {
    const first = await sealEncryptedRecord(context, bytes("same plaintext"), key(1), "epoch:a");
    const second = await sealEncryptedRecord(context, bytes("same plaintext"), key(1), "epoch:a");

    expect(first.nonce).not.toBe(second.nonce);
    expect(first.ciphertext).not.toBe(second.ciphertext);
    expect(first).toMatchObject({
      version: 1,
      suite: ENCRYPTED_RECORD_SUITE,
      purpose: ENCRYPTED_RECORD_PURPOSE,
      ...context,
      keyId: "epoch:a",
    });
  });

  it("rejects a different expected tenant, vault, record, or revision", async () => {
    const envelope = await sealEncryptedRecord(context, bytes("bound"), key(2), "epoch:a");

    for (const field of ["tenantScope", "vaultId", "recordId", "revisionId"] as const) {
      await expectEncryptedRecordError(
        () =>
          openEncryptedRecord(
            {
              ...context,
              [field]: `${context[field]}:other`,
            },
            envelope,
            key(2),
          ),
        "authentication-failed",
      );
    }
  });

  it("rejects header substitution because the public header is authenticated", async () => {
    const envelope = await sealEncryptedRecord(context, bytes("header-bound"), key(3), "epoch:a");
    const substituted = {
      ...envelope,
      keyId: "epoch:b",
    };

    await expectEncryptedRecordError(
      () => openEncryptedRecord(context, substituted, key(3)),
      "authentication-failed",
    );
  });

  it("rejects wrong keys and tampered ciphertext without exposing plaintext", async () => {
    const envelope = await sealEncryptedRecord(context, bytes("do not leak me"), key(4), "epoch:a");
    const tampered = {
      ...envelope,
      ciphertext: `${envelope.ciphertext.slice(0, -1)}${
        envelope.ciphertext.endsWith("A") ? "B" : "A"
      }`,
    };

    await expectEncryptedRecordError(
      () => openEncryptedRecord(context, envelope, key(5)),
      "authentication-failed",
    );
    await expectEncryptedRecordError(
      () => openEncryptedRecord(context, tampered, key(4)),
      "authentication-failed",
    );
  });

  it("rejects malformed envelopes and keys before crypto work", async () => {
    const envelope = await sealEncryptedRecord(context, bytes("valid"), key(6), "epoch:a");

    await expectEncryptedRecordError(
      () =>
        openEncryptedRecord(
          context,
          { ...envelope, nonce: "A" },
          key(6),
        ),
      "invalid-envelope",
    );
    await expectEncryptedRecordError(
      () => sealEncryptedRecord(context, bytes("valid"), new Uint8Array(31), "epoch:a"),
      "invalid-key",
    );
    await expectEncryptedRecordError(
      () =>
        openEncryptedRecord(
          context,
          { ...envelope, version: 2 } as unknown as EncryptedRecordEnvelope,
          key(6),
        ),
      "unsupported-format",
    );
  });

  it("round-trips arbitrary bytes, not only UTF-8 text", async () => {
    const plaintext = Uint8Array.from({ length: 512 }, (_, index) => index % 256);
    const envelope = await sealEncryptedRecord(context, plaintext, key(8), "epoch:a");
    const opened = await openEncryptedRecord(context, envelope, key(8));

    expect(opened).toEqual(plaintext);
    expect(decoder.decode(opened.subarray(80, 86))).toBe("PQRSTU");
  });

  it("exposes the strict envelope validator for server-side shared parsing", async () => {
    const envelope = await sealEncryptedRecord(context, bytes("validate me"), key(9), "epoch:a");
    const parsed = JSON.parse(JSON.stringify(envelope)) as unknown;

    expect(validateEncryptedRecordEnvelope(parsed)).toEqual(envelope);
    expect(() =>
      validateEncryptedRecordEnvelope({ ...envelope, extra: "field" }),
    ).toThrowError(EncryptedRecordError);
    expect(() => validateEncryptedRecordEnvelope({ ...envelope, nonce: "AAAA" })).toThrowError(
      EncryptedRecordError,
    );
    expect(() => validateEncryptedRecordEnvelope({ ...envelope, nonce: "A" })).toThrowError(
      EncryptedRecordError,
    );
    expect(() => validateEncryptedRecordEnvelope({ ...envelope, ciphertext: "AAAA" })).toThrowError(
      EncryptedRecordError,
    );
    expect(() =>
      validateEncryptedRecordEnvelope({ ...envelope, suite: "XChaCha20-Poly1305" }),
    ).toThrowError(EncryptedRecordError);
  });
});
