import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function getLoadablePath() {
  const directory = new URL("./native/", import.meta.url);
  const manifestPath = new URL("binary.json", directory);
  if (!existsSync(manifestPath)) throw new Error("Mirk sqlite-vec native binary is missing; install the optional companion with build scripts enabled");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest.platform !== process.platform || manifest.arch !== process.arch) {
    throw new Error(`Mirk sqlite-vec binary targets ${manifest.platform}/${manifest.arch}, running ${process.platform}/${process.arch}; reinstall the optional companion`);
  }
  const path = fileURLToPath(new URL(manifest.file, directory));
  if (!existsSync(path)) throw new Error("Mirk sqlite-vec native binary is missing; reinstall the optional companion");
  return path;
}
