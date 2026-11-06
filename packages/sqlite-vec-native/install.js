import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const directory = fileURLToPath(new URL("./dist/native/", import.meta.url));
if (!existsSync(`${directory}/provenance.json`)) {
  const prepare = fileURLToPath(new URL("../../native/sqlite-vec/prepare.py", import.meta.url));
  if (!existsSync(prepare)) throw new Error("Mirk sqlite-vec source payload is missing from this package");
  const result = spawnSync(process.env.PYTHON ?? "python3", [prepare, directory], {encoding:"utf8"});
  if (result.status !== 0) throw new Error(`Mirk sqlite-vec workspace preparation failed: ${result.error?.message ?? result.stderr}`);
}
const manifest = JSON.parse(readFileSync(`${directory}/provenance.json`, "utf8"));
const expected = { ...manifest.files, "sqlite-vec.c": manifest.patched_sha256 };
for (const [name, checksum] of Object.entries(expected)) {
  const actual = createHash("sha256").update(readFileSync(`${directory}/${name}`)).digest("hex");
  if (actual !== checksum) throw new Error(`Mirk sqlite-vec source checksum mismatch: ${name}`);
}
const file = process.platform === "win32" ? "vec0.dll" : process.platform === "darwin" ? "vec0.dylib" : "vec0.so";
const output = `building-${file}`;
const compiler = process.env.CC ?? (process.platform === "win32" ? "cl" : "cc");
const args = process.platform === "win32"
  ? ["/nologo", "/O2", "/fp:strict", "/std:c11", "/LD", "sqlite-vec.c", `/Fe:${output}`]
  : ["-O2", "-ffp-contract=off", "-fno-fast-math", "-fPIC", process.platform === "darwin" ? "-dynamiclib" : "-shared", "sqlite-vec.c", "-o", output, "-lm"];
const result = spawnSync(compiler, args, { cwd: directory, encoding: "utf8" });
if (result.error || result.status !== 0) {
  throw new Error(`Mirk sqlite-vec native compilation failed; install a C compiler and SQLite build toolchain or set CC. ${result.error?.message ?? result.stderr ?? result.stdout}`);
}
if (!existsSync(`${directory}/${output}`)) throw new Error("Mirk sqlite-vec compiler did not produce a native binary");
renameSync(`${directory}/${output}`, `${directory}/${file}`);
writeFileSync(`${directory}/binary.json`, JSON.stringify({platform:process.platform,arch:process.arch,file}));
