import { FixtureError } from "../errors.js";
import type { FixtureSource } from "../types.js";
import { createFilesystemFixtureSource } from "./filesystem.js";

export interface PackageFixtureSourceOptions {
  id: string;
  rootUrl: URL;
}

export function createPackageFixtureSource(opts: PackageFixtureSourceOptions): FixtureSource {
  if (opts.rootUrl.protocol !== "file:") {
    throw new FixtureError({
      severity: "error",
      code: "unsupported-package-source",
      message: `Package fixture source "${opts.id}" currently requires a file: root URL.`,
      source: opts.id,
    });
  }
  return createFilesystemFixtureSource({ id: opts.id, root: opts.rootUrl });
}
