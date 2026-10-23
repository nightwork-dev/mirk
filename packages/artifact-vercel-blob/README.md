# @mirk/artifact-vercel-blob

> **Keep your artifact bytes in private Vercel Blob storage, without changing how your app writes
> and verifies files.**

## Why

[`@mirk/artifact`](../artifact) stores generated files such as images, exports, and model outputs.
It tracks each file's checksum, metadata, and origin, and it does not care where the bytes sit.
An app deployed on Vercel has no durable disk, so its bytes belong in Blob storage.

This package implements `@mirk/artifact`'s small `ObjectStore` interface on top of
[`@vercel/blob`](https://vercel.com/docs/vercel-blob). Every object is private and stored at the
key the artifact layer chooses. Blob URLs and credentials stay inside the adapter; the artifact
layer only sees keys, sizes, and media types.

ESM-only.

## Install

```bash
npm install @mirk/artifact @mirk/artifact-vercel-blob @vercel/blob
```

`@vercel/blob` `^2.8.2` is a peer dependency.

## A first look

```ts
import { ArtifactCoordinator } from "@mirk/artifact";
import { StoreArtifactRepository } from "@mirk/artifact/store";
import { PostgresAdapter } from "@mirk/store-postgres";
import { VercelBlobObjectStore } from "@mirk/artifact-vercel-blob";

const postgres = await PostgresAdapter.open({ connectionString: process.env.DATABASE_URL });
const artifacts = new ArtifactCoordinator(
  new VercelBlobObjectStore({ token: process.env.BLOB_READ_WRITE_TOKEN }),
  new StoreArtifactRepository(postgres.kv, { namespace: "artifacts" }),
  { concurrency: { mode: "repository-atomic" } },
);

const artifact = await artifacts.write({
  bytes: new TextEncoder().encode("rendered output"),
  mediaType: "text/plain",
  idempotencyKey: "job-1:output",
});

console.log((await artifacts.verify(artifact.id)).ok); // true
```

With `repository-atomic` concurrency and an atomic repository, several hosts can finalize the same
idempotent output at once and get one artifact.

## Options

```ts
new VercelBlobObjectStore({
  token,      // a read-write token; omit it to use the SDK's managed Vercel OIDC credentials
  storeId,    // the Blob store, when the credentials do not imply one
  maxBytes,   // largest object put accepts; default 16 MiB
  timeoutMs,  // limit for each SDK request, including retries and a streamed download; default 10 s
});
```

The constructor throws a `RangeError` unless `maxBytes` is a positive safe integer.

## Behavior

- Every object uses `access: "private"` with no random suffix, so the key is the Blob pathname.
- `put` streams the source and fails when it exceeds `maxBytes`. `ifAbsent: true` refuses an
  existing key with `ObjectAlreadyExistsError`, and the upload itself refuses to overwrite.
  Without `ifAbsent`, `put` overwrites.
- `put` rejects arbitrary `metadata`. Keep metadata in the artifact repository.
- `get` reads from origin (`useCache: false`), so a read after a write sees the new bytes.
- `delete` removes only the version it observed. If the object changed in between, the SDK's
  `BlobPreconditionFailedError` propagates and the newer object stays.

## Uncertain uploads

A remote upload can succeed and lose its reply, and the SDK has no typed error for losing an
`ifAbsent` race. When an upload fails, the adapter cannot tell whether the bytes at the key are its
own, so it throws `ObjectWriteIndeterminateError` and deletes nothing. `ArtifactCoordinator` then
fails the write with `cleanup: "preserved-indeterminate"` and creates no record. The cost is a
possible orphaned object, which `@mirk/artifact/maintenance` can find; the alternative would be
deleting bytes another writer owns.

## Contract boundaries

This package implements only the `ObjectStore` byte port. It does not list objects, so
maintenance audits over it are partial. It has no browser upload, client token, or webhook
surface.

## License

Apache-2.0
