---
---

Bring the Python artifact port in line with `@mirk/artifact`. Object stores raise
`ObjectWriteRejectedError` when a write stored nothing and `ObjectWriteIndeterminateError` when its
outcome is unknown; the coordinator then never deletes the key, keeps an indeterminate object
(`cleanup="preserved-indeterminate"`), adopts identical left-over bytes at a new write's key, and
refuses different bytes with `object-key-occupied`. The in-memory store's create-if-missing rechecks
the key after reading the source. `ArtifactMaintenance` takes `namespace`, default `"artifacts"`,
and audits only keys under it; `namespace=None` audits the whole store. New lifecycle scenarios
cover rejected and indeterminate writes, adoption, and an occupied key in both languages.
