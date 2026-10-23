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
  new VercelBlobObjectStore({ root: "mirk-artifacts", token: process.env.BLOB_READ_WRITE_TOKEN }),
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
  root,       // required: the pathname prefix this store owns, such as "mirk-artifacts"
  token,      // a read-write token; omit it to use the SDK's managed Vercel OIDC credentials
  storeId,    // the Blob store, when the credentials do not imply one
  maxBytes,   // largest object put accepts; default 16 MiB
  timeoutMs,  // limit for each SDK request, including retries and a streamed download; default 10 s
  listPageSize, // objects per list request; default 1000
});
```

Every key is stored as `<root>/<key>`. `get`, `head`, `delete` and `list` only ever address
pathnames under the root, so objects that other apps or uploads keep in the same Blob store are
invisible to the artifact layer and to maintenance. The root must be a valid relative key; the
constructor throws without one, and throws a `RangeError` unless `maxBytes` is a positive safe
integer.

## Behavior

- Every object uses `access: "private"` with no random suffix, so the key is the Blob pathname.
- `put` streams the source and fails with a `RangeError` when it exceeds `maxBytes`; the upload
  never completes. `ifAbsent: true` refuses an existing key with `ObjectAlreadyExistsError`, both
  before the upload and when the service refuses to overwrite a key another writer created
  meanwhile. Without `ifAbsent`, `put` overwrites.
- `put` rejects arbitrary `metadata`. Keep metadata in the artifact repository.
- `get` reads from origin (`useCache: false`), so a read after a write sees the new bytes.
- `delete` removes only the version it observed, with the ETag as a precondition. It returns
  `false` when nothing was deleted: the key is missing, another deleter won, or a concurrent
  overwrite replaced the object, which stays. Like the other object stores, it reports races as
  `false`, not as errors. If the service returns no ETag, `delete` refuses with
  `VercelBlobObjectStoreError` (`code: "missing-etag"`) instead of deleting unconditionally.
- `list(prefix)` returns every object under the prefix in key order, paging through the service,
  so `@mirk/artifact/maintenance` can audit the store completely.

## Uncertain uploads

A remote upload can succeed and lose its reply. When an upload fails in a way that does not prove
the bytes stayed out (a network failure, a timeout, a server error), the adapter cannot tell
whether the object at the key is its own, so it throws `ObjectWriteIndeterminateError` and deletes
nothing. `ArtifactCoordinator` then fails the write with `cleanup: "preserved-indeterminate"` and
creates no record. A retry that writes the same bytes under the same id adopts the object, and
`@mirk/artifact/maintenance` finds any other leftover and removes it with
`delete-unreferenced-object`.

These failures prove nothing landed. The service refusing to overwrite an existing key is
`ObjectAlreadyExistsError`. A source over `maxBytes` or failing mid-stream, and refusals of the
request itself such as `BlobAccessError`, `BlobStoreNotFoundError`, or `BlobFileTooLargeError`, are
`ObjectWriteRejectedError` with the original error as `cause`. The coordinator never deletes the
key after either, so a concurrent writer's object at the same key survives.
The overwrite refusal is recognized by the SDK's message, because the SDK has no typed error for
it; the body is a stream the SDK sends once, so the refusal cannot be the answer to a retry of an
upload that already landed.

## Contract boundaries

This package implements only the `ListableObjectStore` byte port. It has no browser upload,
client token, or webhook surface.

## License

Apache-2.0
