import { MigrationError } from "./errors.js";
import type { MigrationVerifier, MigrationVerificationResult } from "./types.js";

export type MigrationCopy<TResult> =
  | TResult
  | PromiseLike<TResult>
  | (() => TResult | PromiseLike<TResult>);

/** Run a copy operation and a caller-owned, post-copy verification. */
export async function runMigrationWithVerification<TResult>(
  copy: MigrationCopy<TResult>,
  verify: MigrationVerifier<TResult>
): Promise<MigrationVerificationResult<TResult>> {
  if (typeof verify !== "function")
    throw new MigrationError("invalid-verifier", "verify must be a function");
  const result =
    typeof copy === "function"
      ? await (copy as () => TResult | PromiseLike<TResult>)()
      : await copy;
  const verification = await verify(result);
  return { result, verification };
}

