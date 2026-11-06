import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export class NativeCompanionUnavailableError extends Error {
  readonly code = "native-companion-unavailable";
}

export function getLoadablePath() {
  const directory = new URL("./native/", import.meta.url);
  const manifestPath = new URL("binary.json", directory);
  if (!existsSync(manifestPath)) throw new NativeCompanionUnavailableError("Mirk sqlite-vec native binary is missing; install the optional companion with build scripts enabled");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (!manifest || typeof manifest.platform !== "string" || typeof manifest.arch !== "string" || typeof manifest.file !== "string") {
    throw new Error("Mirk sqlite-vec binary manifest is malformed");
  }
  if (manifest.platform !== process.platform || manifest.arch !== process.arch) {
    throw new NativeCompanionUnavailableError(`Mirk sqlite-vec binary targets ${manifest.platform}/${manifest.arch}, running ${process.platform}/${process.arch}; reinstall the optional companion`);
  }
  const expectedFile = process.platform === "win32" ? "vec0.dll" : process.platform === "darwin" ? "vec0.dylib" : "vec0.so";
  if (manifest.file !== expectedFile) throw new Error("Mirk sqlite-vec binary manifest filename is malformed");
  const path = fileURLToPath(new URL(manifest.file, directory));
  if (!existsSync(path)) throw new NativeCompanionUnavailableError("Mirk sqlite-vec native binary is missing; reinstall the optional companion");
  return path;
}
