#!/usr/bin/env node

/**
 * Package-owned release evidence for Mirk.
 *
 * This command deliberately operates on the package tarball, not on a
 * workspace link.  It is useful locally (`--package @mirk/store`) and in CI
 * (`--all`).  The receipt is build evidence only; it does not assert npm
 * publication or downstream adoption.
 */

import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

const ROOT_BOUNDARIES = new Map([
  ["@mirk/store", { forbidden: ["better-sqlite3", "sqlite-vec"] }],
  [
    "@mirk/fixtures",
    { forbidden: ["node:fs", "node:path", "node:url", "node:module"] },
  ],
]);

const NATIVE_DEPENDENCY_NAMES = new Set([
  "better-sqlite3",
  "sqlite-vec",
  "@surrealdb/node",
  "@surrealdb/wasm",
  "opendal",
  "pg",
  "@libsql/client",
]);

const LEAK_PATTERNS = [
  {
    pattern: /(?:\/Users\/[^\s/]+|\/home\/[^\s/]+|[A-Za-z]:\\Users\\[^\s\\]+)/g,
    label: "private home path",
  },
  { pattern: /file:\/\/(?:Users|home|private)\b/gi, label: "private file URL" },
  {
    pattern:
      /(?:https?:\/\/)(?:localhost|127\.0\.0\.1|0\.0\.0\.0|[^\s/]+\.(?:local|internal|corp))(?:\b|\/)/gi,
    label: "private registry or host",
  },
  {
    pattern: /\b(?:verdaccio|artifactory|nexus)\b/gi,
    label: "private registry name",
  },
];

const PACKED_PATH_BLOCKLIST = [
  /^(?:src|test|tests|node_modules|\.git)(?:\/|$)/,
  /(?:^|\/)(?:tsconfig|vitest|jest|eslint|prettier)(?:\.|\/|$)/,
  /(?:^|\/)pnpm-lock\.yaml$/,
];

const HELP = `Usage: node scripts/verify-package-release.mjs --package <name> [options]

Options:
  --all                 verify every public package
  --skip-build          do not run the package build hook
  --skip-test           do not run the package test hook
  --skip-typecheck      do not run the package typecheck hook
  --skip-install        skip the temporary clean-consumer install/import
  --publication         require a clean source tree
  --receipt-dir <path>  receipt directory (default: .mirk-release)
  --out <path>          exact receipt path (single package only)
  --forbidden-name <n>  reject a configured private project name in the tarball
  --keep-temp           retain temporary pack/install directories
  --no-receipt          verify without writing a receipt
`;

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(
      `release:verify: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    process.exitCode = 1;
  });
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const workspacePackages = discoverPackages();
  const packages = selectPackages(
    workspacePackages,
    options.packageNames,
    options.all
  );
  if (packages.length === 0) throw new Error("no public packages selected");

  const outputs = [];
  for (const packageInfo of packages) {
    outputs.push(await verifyPackage(packageInfo, workspacePackages, options));
  }

  for (const receipt of outputs) {
    console.log(
      `release:verify: ${receipt.package}@${receipt.version} passed (${receipt.tarballSha256})`
    );
  }
  return outputs;
}

function parseArgs(argv) {
  const options = {
    packageNames: [],
    all: false,
    build: true,
    test: true,
    typecheck: true,
    install: true,
    publication: false,
    receipt: true,
    receiptDir: ".mirk-release",
    out: undefined,
    keepTemp: false,
    forbiddenNames: parseForbiddenNames(
      process.env.MIRK_RELEASE_FORBIDDEN_NAMES
    ),
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") continue;
    if (arg === "--all") options.all = true;
    else if (arg === "--package")
      options.packageNames.push(requireArg(argv, ++index, arg));
    else if (arg === "--skip-build") options.build = false;
    else if (arg === "--skip-test") options.test = false;
    else if (arg === "--skip-typecheck") options.typecheck = false;
    else if (arg === "--skip-install") options.install = false;
    else if (arg === "--publication" || arg === "--require-clean")
      options.publication = true;
    else if (arg === "--no-receipt") options.receipt = false;
    else if (arg === "--receipt-dir")
      options.receiptDir = requireArg(argv, ++index, arg);
    else if (arg === "--out") options.out = requireArg(argv, ++index, arg);
    else if (arg === "--keep-temp") options.keepTemp = true;
    else if (arg === "--forbidden-name")
      options.forbiddenNames.push(requireArg(argv, ++index, arg));
    else if (arg === "--help" || arg === "-h") {
      console.log(HELP);
      process.exit(0);
    } else {
      throw new Error(`unknown argument ${arg}`);
    }
  }

  if (options.packageNames.length > 0 && options.all) {
    throw new Error("use --all or --package, not both");
  }
  if (options.out && options.packageNames.length !== 1) {
    throw new Error("--out requires exactly one --package");
  }
  if (!options.all && options.packageNames.length === 0) {
    throw new Error("select a package with --package or use --all");
  }
  return options;
}

function requireArg(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith("--"))
    throw new Error(`${flag} requires a value`);
  return value;
}

function parseForbiddenNames(value) {
  return value
    ? value
        .split(",")
        .map((name) => name.trim())
        .filter(Boolean)
    : [];
}

function discoverPackages() {
  const entries = readdirSync(join(root, "packages"), { withFileTypes: true });
  const packageInfos = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const directory = entry.name;
      const manifestPath = join(root, "packages", directory, "package.json");
      if (!existsSync(manifestPath)) return undefined;
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      if (manifest.private === true) return undefined;
      return {
        directory,
        path: join(root, "packages", directory),
        manifest,
        manifestPath,
      };
    })
    .filter(Boolean)
    .sort((a, b) => compareStrings(a.manifest.name, b.manifest.name));

  return packageInfos;
}

function selectPackages(packageInfos, names, all) {
  if (all) return packageInfos;
  return names.map((name) => {
    const found = packageInfos.find(
      (item) => item.manifest.name === name || item.directory === name
    );
    if (!found) throw new Error(`public package not found: ${name}`);
    return found;
  });
}

function workspaceReleaseTrain(packageInfo, workspacePackages) {
  const byName = new Map(
    workspacePackages.map((item) => [item.manifest.name, item])
  );
  const ordered = [];
  const visiting = new Set();
  const visited = new Set();

  function visit(item, chain) {
    const name = item.manifest.name;
    if (visited.has(name)) return;
    if (visiting.has(name)) {
      throw new Error(
        `${
          packageInfo.manifest.name
        }: workspace release train has a runtime dependency cycle: ${[
          ...chain,
          name,
        ].join(" -> ")}`
      );
    }
    visiting.add(name);
    for (const dependency of runtimeDependencies(item.manifest)) {
      const workspaceDependency = byName.get(dependency.name);
      if (!workspaceDependency) {
        if (dependency.workspaceOnly) {
          throw new Error(
            `${packageInfo.manifest.name}: missing workspace release-train package ${dependency.name}, required by ${name}`
          );
        }
        continue;
      }
      visit(workspaceDependency, [...chain, name]);
    }
    visiting.delete(name);
    visited.add(name);
    if (name !== packageInfo.manifest.name) ordered.push(item);
  }

  visit(packageInfo, []);
  return ordered;
}

function runtimeDependencies(manifest) {
  const dependencies = new Map();
  const sections = [
    manifest.dependencies,
    manifest.optionalDependencies,
    manifest.peerDependencies,
    manifest.publishConfig?.dependencies,
  ];
  for (const section of sections) {
    for (const [name, range] of Object.entries(section ?? {})) {
      const workspaceOnly = /^(?:workspace:|catalog:|link:|file:)/i.test(
        String(range)
      );
      dependencies.set(name, {
        name,
        workspaceOnly:
          workspaceOnly || dependencies.get(name)?.workspaceOnly === true,
      });
    }
  }
  return [...dependencies.values()].sort((a, b) =>
    compareStrings(a.name, b.name)
  );
}

async function verifyPackage(packageInfo, workspacePackages, options) {
  const checks = [];
  let source = await readSourceState(packageInfo.path);
  const evidence = {
    package: packageInfo.manifest.name,
    version: packageInfo.manifest.version,
    tarballSha256: undefined,
    packedInputSha256: undefined,
    packedFiles: undefined,
    publicExports: undefined,
  };
  if (options.publication && !source.clean) {
    throw new Error(
      `${packageInfo.manifest.name}: publication receipt requires a clean source tree`
    );
  }

  await runHook(packageInfo, "build", options.build, checks, options);
  await runHook(packageInfo, "test", options.test, checks, options);
  await runHook(packageInfo, "typecheck", options.typecheck, checks, options);
  source = await readSourceState(packageInfo.path);
  if (options.publication && !source.clean) {
    throw new Error(
      `${packageInfo.manifest.name}: package hooks left the source tree dirty; refusing publication receipt`
    );
  }

  const releaseTrainPackages = workspaceReleaseTrain(
    packageInfo,
    workspacePackages
  );
  const tempRoot = await makeTempRoot(packageInfo.manifest.name);
  try {
    const releaseTrain = await packReleaseTrain(releaseTrainPackages, tempRoot);
    const tarball = await packPackage(packageInfo, tempRoot);
    const tarballBytes = readFileSync(tarball);
    evidence.tarballSha256 = sha256(tarballBytes);
    const extracted = join(tempRoot, "package");
    await extractTarball(tarball, tempRoot);
    const packedManifest = readJson(join(extracted, "package.json"));
    const packedFiles = listPackedFiles(tempRoot);
    evidence.package = packedManifest.name;
    evidence.version = packedManifest.version;
    evidence.packedFiles = packedFiles;
    evidence.publicExports = exportKeys(packedManifest.exports);

    checkPackedPaths(packedFiles);
    const attribution = buildPackedInputAttribution(
      packageInfo,
      extracted,
      packedFiles
    );
    evidence.packedInputSha256 = canonicalDigest(attribution.records);
    checks.push(
      passed(
        "packed-tarball-contents",
        `${packedFiles.length} files; every file has a source attribution`
      )
    );

    checkPackageMetadata(packedManifest);
    checkLeakage(
      extracted,
      packedFiles,
      options.forbiddenNames,
      packageInfo.manifest.name
    );
    checks.push(
      passed(
        "workspace-catalog-private-leakage",
        "packed metadata and files contain no forbidden references"
      )
    );
    checks.push(
      passed(
        "workspace-release-train",
        releaseTrain.length > 0
          ? `local tarballs prepared in dependency order: ${releaseTrain
              .map(
                (item) =>
                  `${item.manifest.name}@${
                    item.manifest.version
                  }#${item.tarballSha256.slice(0, 12)}`
              )
              .join(", ")}`
          : "package has no workspace runtime dependencies"
      )
    );

    const publicExports = evidence.publicExports;
    checkExportTargets(extracted, packedManifest, publicExports);
    evidence.publicExports = publicExports;
    checks.push(
      passed(
        "public-export-map",
        `${publicExports.length} public export(s) resolve to packed files`
      )
    );
    checks.push(
      passed(
        "public-type-declarations",
        "manifest and every concrete public export provide packed declarations"
      )
    );

    if (ROOT_BOUNDARIES.has(packageInfo.manifest.name)) {
      checkRootDependencyBoundary(
        packageInfo.manifest.name,
        extracted,
        packedManifest,
        publicExports
      );
      checks.push(
        passed(
          "root-dependency-boundary",
          "root runtime graph is free of Node-only/native adapter dependencies"
        )
      );
    } else {
      checks.push(
        skipped(
          "root-dependency-boundary",
          "no root boundary rule is configured for this package"
        )
      );
    }

    if (options.install) {
      await cleanConsumerSmoke({
        packageInfo,
        packedManifest,
        publicExports,
        extracted,
        tarball,
        tempRoot,
        releaseTrain,
      });
      checks.push(
        passed(
          "clean-consumer-install",
          "temporary generic fixture installed the local release train plus registry-only external dependencies"
        )
      );
      checks.push(
        passed(
          "public-subpath-imports",
          `${publicExports.length} public export(s) imported from the installed tarball`
        )
      );
    } else {
      checks.push(skipped("clean-consumer-install", "--skip-install"));
      checks.push(skipped("public-subpath-imports", "--skip-install"));
    }

    checks.push(
      source.clean
        ? passed("source-clean", "source tree is clean")
        : passed(
            "source-clean",
            "source tree is dirty; receipt is explicitly local and non-publication"
          )
    );

    const receipt = await makeReceipt(evidence, source, checks);

    if (options.receipt) {
      writeReceipt(receipt, options);
    }
    return receipt;
  } catch (error) {
    checks.push({
      name: "verification",
      status: "failed",
      detail: error instanceof Error ? error.message : String(error),
    });
    if (
      options.receipt &&
      evidence.tarballSha256 &&
      evidence.packedInputSha256 &&
      evidence.packedFiles &&
      evidence.publicExports
    ) {
      const failedReceipt = await makeReceipt(evidence, source, checks);
      try {
        writeReceipt(failedReceipt, options);
      } catch (receiptError) {
        console.error(
          `release:verify: unable to write failure receipt: ${
            receiptError instanceof Error
              ? receiptError.message
              : String(receiptError)
          }`
        );
      }
    }
    throw error;
  } finally {
    if (!options.keepTemp) rmSync(tempRoot, { recursive: true, force: true });
    else console.log(`release:verify: retained temporary files at ${tempRoot}`);
  }
}

async function makeReceipt(evidence, source, checks) {
  return {
    schema: "mirk-release-receipt/v1",
    source: {
      commit: source.commit,
      clean: source.clean,
      ...(source.trackedDiffSha256
        ? { trackedDiffSha256: source.trackedDiffSha256 }
        : {}),
      ...(source.untrackedInputsSha256
        ? { untrackedInputsSha256: source.untrackedInputsSha256 }
        : {}),
      packedInputSha256: evidence.packedInputSha256,
    },
    package: evidence.package,
    version: evidence.version,
    tarballSha256: evidence.tarballSha256,
    packedFiles: evidence.packedFiles,
    publicExports: evidence.publicExports,
    nodeVersion: process.version,
    pnpmVersion: await pnpmVersion(),
    checks,
  };
}

async function runHook(packageInfo, hook, enabled, checks, options) {
  if (!enabled) {
    checks.push(skipped(hook, "command line option"));
    return;
  }
  console.log(`release:verify: ${packageInfo.manifest.name} ${hook}`);
  const result = await execFileAsync(
    "pnpm",
    ["--filter", packageInfo.manifest.name, "run", hook],
    {
      cwd: root,
      maxBuffer: 32 * 1024 * 1024,
    }
  );
  if (hook !== "test") {
    checks.push(passed(hook));
    return;
  }
  const tests = parseVitestTestCounts(
    `${result.stdout ?? ""}\n${result.stderr ?? ""}`
  );
  if (!tests) {
    if (options.publication) {
      checks.push({
        name: hook,
        status: "failed",
        detail:
          "test hook exited 0 but no vitest test summary was found; cannot prove any test executed",
      });
      throw new Error(
        `${packageInfo.manifest.name}: test output has no vitest summary; refusing publication receipt`
      );
    }
    console.warn(
      `release:verify: warning: ${packageInfo.manifest.name} test output has no vitest summary; executed count unknown`
    );
    checks.push(passed(hook, "vitest summary not found; executed count unknown"));
    return;
  }
  const detail = `${tests.executed} executed (${tests.passed} passed, ${tests.failed} failed), ${tests.skipped} skipped, ${tests.todo} todo of ${tests.total} total`;
  if (tests.executed === 0) {
    if (options.publication) {
      checks.push({ name: hook, status: "failed", detail, tests });
      throw new Error(
        `${packageInfo.manifest.name}: test hook executed zero tests (${tests.skipped} skipped); refusing publication receipt`
      );
    }
    console.warn(
      `release:verify: warning: ${packageInfo.manifest.name} test hook executed zero tests (${tests.skipped} skipped)`
    );
  }
  checks.push({ name: hook, status: "passed", detail, tests });
}

function parseVitestTestCounts(output) {
  const plain = output.replace(/\[[0-9;]*m/g, "");
  const summaries = [
    ...plain.matchAll(/^[\s|]*Tests\s+([^\n(]*)\((\d+)\)\s*$/gm),
  ];
  if (summaries.length === 0) return undefined;
  const tests = { executed: 0, passed: 0, failed: 0, skipped: 0, todo: 0, total: 0 };
  for (const summary of summaries) {
    tests.total += Number(summary[2]);
    for (const segment of summary[1].split("|")) {
      const part = segment.trim().match(/^(\d+)\s+(passed|failed|skipped|todo)$/);
      if (part) tests[part[2]] += Number(part[1]);
    }
  }
  tests.executed = tests.passed + tests.failed;
  return tests;
}

async function packPackage(packageInfo, tempRoot) {
  await execFileAsync("pnpm", ["pack", "--pack-destination", tempRoot], {
    cwd: packageInfo.path,
    maxBuffer: 32 * 1024 * 1024,
  });
  const tarballs = readdirSync(tempRoot)
    .filter((name) => name.endsWith(".tgz"))
    .map((name) => join(tempRoot, name));
  if (tarballs.length !== 1)
    throw new Error(
      `${packageInfo.manifest.name}: expected exactly one packed tarball`
    );
  return tarballs[0];
}

async function packReleaseTrain(packageInfos, tempRoot) {
  if (packageInfos.length === 0) return [];
  const trainRoot = join(tempRoot, "release-train");
  mkdirSync(trainRoot, { recursive: true });
  const packed = [];
  for (const packageInfo of packageInfos) {
    const packageRoot = join(trainRoot, safeName(packageInfo.manifest.name));
    mkdirSync(packageRoot, { recursive: true });
    const tarball = await packPackage(packageInfo, packageRoot);
    await validateTarballMembers(tarball);
    const manifest = await readPackedManifest(tarball);
    if (manifest.name !== packageInfo.manifest.name) {
      throw new Error(
        `${packageInfo.manifest.name}: release-train tarball identifies itself as ${manifest.name}`
      );
    }
    checkPackageMetadata(manifest);
    packed.push({
      packageInfo,
      tarball,
      manifest,
      tarballSha256: sha256(readFileSync(tarball)),
    });
  }
  return packed;
}

async function readPackedManifest(tarball) {
  const result = await execFileAsync(
    "tar",
    ["-xOzf", tarball, "package/package.json"],
    { maxBuffer: 32 * 1024 * 1024 }
  );
  return JSON.parse(result.stdout);
}

async function extractTarball(tarball, tempRoot) {
  await validateTarballMembers(tarball);
  await execFileAsync("tar", ["-xzf", tarball, "-C", tempRoot], {
    maxBuffer: 32 * 1024 * 1024,
  });
}

async function validateTarballMembers(tarball) {
  const listing = await execFileAsync("tar", ["-tzf", tarball], {
    maxBuffer: 32 * 1024 * 1024,
  });
  for (const member of listing.stdout.split(/\r?\n/).filter(Boolean)) {
    const normalized = member.replace(/^\.\//, "");
    if (
      !normalized.startsWith("package/") ||
      normalized.startsWith("/") ||
      normalized.split("/").includes("..")
    ) {
      throw new Error(`unsafe tarball member path: ${member}`);
    }
  }
}

function listPackedFiles(tempRoot) {
  const packageRoot = join(tempRoot, "package");
  if (!existsSync(packageRoot))
    throw new Error("packed tarball has no package/ root");
  const files = walkFiles(packageRoot)
    .map((path) => toPosix(relative(packageRoot, path)))
    .sort();
  if (!files.includes("package.json"))
    throw new Error("packed tarball has no package.json");
  return files;
}

function buildPackedInputAttribution(packageInfo, extracted, packedFiles) {
  const records = [];
  for (const file of packedFiles) {
    const packedPath = join(extracted, ...file.split("/"));
    let sourcePath;
    let sourceLabel;
    if (
      file === "LICENSE" &&
      !existsSync(join(packageInfo.path, file)) &&
      existsSync(join(root, file))
    ) {
      sourcePath = join(root, file);
      sourceLabel = `workspace/${file}`;
    } else {
      sourcePath = join(packageInfo.path, ...file.split("/"));
      sourceLabel = `${packageInfo.directory}/${file}`;
    }
    if (!isRegularFile(sourcePath)) {
      throw new Error(
        `${packageInfo.manifest.name}: packed input cannot be attributed: ${file}`
      );
    }
    const sourceBytes = readFileSync(sourcePath);
    const packedBytes = readFileSync(packedPath);
    if (file !== "package.json" && !sourceBytes.equals(packedBytes)) {
      throw new Error(
        `${packageInfo.manifest.name}: packed file differs from attributed input: ${file}`
      );
    }
    records.push({
      path: sourceLabel,
      sha256: sha256(sourceBytes),
      size: sourceBytes.length,
    });
  }
  return { records: records.sort((a, b) => compareStrings(a.path, b.path)) };
}

function checkPackageMetadata(manifest) {
  for (const section of [
    "dependencies",
    "optionalDependencies",
    "peerDependencies",
    "devDependencies",
  ]) {
    for (const [name, range] of Object.entries(manifest[section] ?? {})) {
      if (/^(?:workspace:|catalog:|link:|file:)/i.test(String(range))) {
        throw new Error(
          `${manifest.name}: packed ${section}.${name} retains a workspace/catalog/private path reference`
        );
      }
    }
  }
  for (const [name, range] of Object.entries(
    manifest.publishConfig?.dependencies ?? {}
  )) {
    if (/^(?:workspace:|catalog:|link:|file:)/i.test(String(range))) {
      throw new Error(
        `${manifest.name}: packed publishConfig.dependencies.${name} retains a private path reference`
      );
    }
  }
}

function checkPackedPaths(files) {
  for (const file of files) {
    if (
      !file ||
      file.startsWith("/") ||
      file.includes("\\") ||
      file.split("/").includes("..")
    ) {
      throw new Error(`unsafe packed path: ${file}`);
    }
    if (PACKED_PATH_BLOCKLIST.some((pattern) => pattern.test(file))) {
      throw new Error(`development-only file leaked into tarball: ${file}`);
    }
  }
}

function checkLeakage(extracted, files, forbiddenNames, packageName) {
  const names = forbiddenNames
    .map((name) => name.trim())
    .filter((name) => name && name.toLowerCase() !== packageName.toLowerCase());
  for (const file of files) {
    const absolute = join(extracted, ...file.split("/"));
    const bytes = readFileSync(absolute);
    if (bytes.includes(0)) continue;
    const text = bytes.toString("utf8");
    for (const { pattern, label } of LEAK_PATTERNS) {
      if (pattern.test(text)) {
        pattern.lastIndex = 0;
        throw new Error(`${packageName}: ${label} leaked in ${file}`);
      }
      pattern.lastIndex = 0;
    }
    for (const name of names) {
      const pattern = new RegExp(
        `(^|[^A-Za-z0-9_])${escapeRegExp(name)}([^A-Za-z0-9_]|$)`,
        "i"
      );
      if (pattern.test(text))
        throw new Error(
          `${packageName}: private project name "${name}" leaked in ${file}`
        );
    }
  }
}

function checkExportTargets(extracted, manifest, exports) {
  if (manifest.type !== "module")
    throw new Error(
      `${manifest.name}: packed package must be ESM-only (type: module)`
    );
  if (typeof manifest.types !== "string")
    throw new Error(
      `${manifest.name}: packed package has no public type declaration entry`
    );
  assertPackedTarget(extracted, manifest.types, `${manifest.name} types`);
  for (const key of exports) {
    const value = manifest.exports[key];
    const target = exportTarget(value);
    if (!target || key.includes("*")) continue;
    assertPackedTarget(extracted, target, `${manifest.name} export ${key}`);
    if (typeof value === "object" && value !== null) {
      if (typeof value.types !== "string")
        throw new Error(
          `${manifest.name}: export ${key} has no public type declaration target`
        );
      assertPackedTarget(
        extracted,
        value.types,
        `${manifest.name} export ${key} types`
      );
    }
  }
}

function assertPackedTarget(extracted, target, label) {
  if (typeof target !== "string" || !target.startsWith("./"))
    throw new Error(`${label} has a non-relative target`);
  const file = resolve(extracted, target.slice(2));
  if (!isWithin(file, extracted) || !existsSync(file) || !isRegularFile(file)) {
    throw new Error(
      `${label} target is absent or unsafe in tarball: ${target}`
    );
  }
}

function checkRootDependencyBoundary(
  packageName,
  extracted,
  manifest,
  exports
) {
  const rule = ROOT_BOUNDARIES.get(packageName);
  if (!rule) return;
  const rootExport = manifest.exports?.["."];
  const rootTarget = exportTarget(rootExport);
  if (!rootTarget || !rootTarget.endsWith(".js")) return;
  const entry = join(extracted, ...rootTarget.slice(2).split("/"));
  const reachable = reachableRuntimeFiles(entry, extracted);
  const banned = rule.forbidden.filter((name) =>
    reachable.some((file) => readFileSync(file, "utf8").includes(name))
  );
  if (banned.length > 0) {
    throw new Error(
      `${packageName}: root export reaches native/Node-only dependency ${banned.join(
        ", "
      )}`
    );
  }

  // For generic ports, any native dependency in the package must be reachable
  // only from an explicitly non-root export. This catches an accidental
  // barrel re-export while leaving adapter packages free to own their backend.
  if (packageName === "@mirk/store") {
    for (const file of walkFiles(join(extracted, "dist"))) {
      if (!file.endsWith(".js")) continue;
      const text = readFileSync(file, "utf8");
      const nativeDependency = [...NATIVE_DEPENDENCY_NAMES].find((name) =>
        text.includes(name)
      );
      if (nativeDependency && reachable.includes(file)) {
        throw new Error(
          `${packageName}: native implementation ${nativeDependency} leaked through root export: ${relative(
            extracted,
            file
          )}`
        );
      }
    }
  }
}

function reachableRuntimeFiles(entry, extracted) {
  const seen = new Set();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.shift();
    if (seen.has(file) || !existsSync(file)) continue;
    seen.add(file);
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(
      /(?:from\s+|import\s*\()["']([^"']+)["']/g
    )) {
      const specifier = match[1];
      if (!specifier.startsWith(".")) continue;
      const candidate = resolveImportFile(dirname(file), specifier, extracted);
      if (candidate) queue.push(candidate);
    }
  }
  return [...seen];
}

function resolveImportFile(directory, specifier, extracted) {
  const base = resolve(directory, specifier);
  const candidates = [
    base,
    `${base}.js`,
    `${base}.mjs`,
    `${base}.cjs`,
    join(base, "index.js"),
  ];
  return candidates.find(
    (candidate) =>
      candidate.startsWith(`${extracted}${sep}`) && existsSync(candidate)
  );
}

async function cleanConsumerSmoke({
  packageInfo,
  packedManifest,
  publicExports,
  extracted,
  tarball,
  tempRoot,
  releaseTrain,
}) {
  const fixture = join(tempRoot, "consumer");
  mkdirSync(fixture, { recursive: true });
  const localTrainDependencies = Object.fromEntries(
    releaseTrain.map((item) => [item.manifest.name, `file:${item.tarball}`])
  );
  const dependencies = {
    ...localTrainDependencies,
    [packedManifest.name]: `file:${tarball}`,
  };
  const optionalPeers = new Set(
    Object.entries(packedManifest.peerDependenciesMeta ?? {})
      .filter(([, meta]) => meta && meta.optional === true)
      .map(([name]) => name)
  );
  for (const [name, range] of Object.entries(
    packedManifest.peerDependencies ?? {}
  )) {
    if (
      optionalPeers.has(name) &&
      !publicExports.some((key) =>
        exportUsesDependency(packedManifest, key, extracted, name)
      )
    )
      continue;
    if (!(name in dependencies)) {
      dependencies[name] = firstPeerRange(String(range));
    }
  }
  writeFileSync(
    join(fixture, "package.json"),
    `${JSON.stringify(
      {
        name: "mirk-release-fixture",
        version: "0.0.0",
        private: true,
        type: "module",
        dependencies,
        ...(releaseTrain.length > 0
          ? { pnpm: { overrides: localTrainDependencies } }
          : {}),
      },
      null,
      2
    )}\n`
  );
  await execFileAsync(
    "pnpm",
    [
      "install",
      "--ignore-workspace",
      "--no-lockfile",
      "--prod",
      "--ignore-scripts",
      "--config.auto-install-peers=false",
      "--registry=https://registry.npmjs.org",
    ],
    { cwd: fixture, maxBuffer: 32 * 1024 * 1024 }
  );

  const specifiers = publicExports.filter((key) => !key.includes("*"));
  const imports = specifiers.map((key) =>
    key === "." ? packedManifest.name : `${packedManifest.name}${key.slice(1)}`
  );
  const importScript = `for (const specifier of ${JSON.stringify(
    imports
  )}) await import(specifier);`;
  await execFileAsync("node", ["--input-type=module", "-e", importScript], {
    cwd: fixture,
    maxBuffer: 32 * 1024 * 1024,
  });
}

function exportUsesDependency(manifest, key, extracted, dependency) {
  if (key.includes("*")) return false;
  const target = exportTarget(manifest.exports[key]);
  if (!target || !target.startsWith("./")) return false;
  const entry = resolve(extracted, target.slice(2));
  return reachableRuntimeFiles(entry, extracted).some((file) =>
    readFileSync(file, "utf8").includes(dependency)
  );
}

function firstPeerRange(range) {
  const first = range.split("||")[0].trim();
  return first || "*";
}

function exportKeys(exports) {
  if (!exports || typeof exports !== "object")
    throw new Error("package has no public export map");
  return Object.keys(exports).sort();
}

function exportTarget(value) {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return undefined;
  return (
    value.import ??
    value.default ??
    value.require ??
    value.node ??
    value.browser ??
    value.types
  );
}

async function readSourceState(packagePath) {
  const commit = (await git(["rev-parse", "HEAD"])).trim();
  const status = await git([
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
  ]);
  const clean = status.length === 0;
  const diff = await git(["diff", "--no-ext-diff", "--binary", "HEAD", "--"]);
  const trackedDiffSha256 = diff ? sha256(Buffer.from(diff)) : undefined;
  const untrackedPaths = parseStatusPaths(status).filter((path) =>
    path.startsWith(`${toPosix(relative(root, packagePath))}/`)
  );
  const records = [];
  for (const path of untrackedPaths) {
    const absolute = resolve(root, path);
    if (isRegularFile(absolute)) {
      const bytes = readFileSync(absolute);
      records.push({ path, sha256: sha256(bytes), size: bytes.length });
    }
  }
  return {
    commit,
    clean,
    trackedDiffSha256,
    untrackedInputsSha256:
      records.length > 0
        ? canonicalDigest(
            records.sort((a, b) => compareStrings(a.path, b.path))
          )
        : undefined,
  };
}

function parseStatusPaths(status) {
  const paths = [];
  for (const record of status.split("\0")) {
    if (!record) continue;
    const path = record.slice(3);
    if (path) paths.push(toPosix(path));
  }
  return paths;
}

async function git(args) {
  const result = await execFileAsync("git", args, {
    cwd: root,
    maxBuffer: 32 * 1024 * 1024,
  });
  return result.stdout;
}

async function pnpmVersion() {
  try {
    return (
      await execFileAsync("pnpm", ["--version"], { cwd: root })
    ).stdout.trim();
  } catch {
    return "unknown";
  }
}

async function makeTempRoot(packageName) {
  const safe = safeName(packageName);
  const base = join(tmpdir(), `mirk-release-${safe}-`);
  const { mkdtemp } = await import("node:fs/promises");
  return mkdtemp(base);
}

function walkFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    const stats = lstatSync(path);
    if (stats.isSymbolicLink())
      throw new Error(`symlink is not allowed in packed tarball: ${path}`);
    if (stats.isDirectory()) files.push(...walkFiles(path));
    else if (stats.isFile()) files.push(path);
    else
      throw new Error(
        `unsupported filesystem entry in packed tarball: ${path}`
      );
  }
  return files;
}

function isRegularFile(path) {
  try {
    const stats = lstatSync(path);
    return stats.isFile() && !stats.isSymbolicLink();
  } catch {
    return false;
  }
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function canonicalDigest(records) {
  const canonical = records
    .map((record) =>
      JSON.stringify({
        path: record.path,
        sha256: record.sha256,
        size: record.size,
      })
    )
    .join("\n");
  return sha256(Buffer.from(`${canonical}\n`));
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function safeName(name) {
  return name
    .replace(/^@/, "")
    .replace(/[\\/]/g, "-")
    .replace(/[^A-Za-z0-9._-]+/g, "-");
}

function compareStrings(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function writeReceipt(receipt, options) {
  const receiptPath = options.out
    ? resolveReceiptPath(options.out)
    : join(
        resolveReceiptPath(options.receiptDir),
        `${safeName(receipt.package)}-${receipt.version}.json`
      );
  mkdirSync(dirname(receiptPath), { recursive: true });
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  console.log(`release:verify: receipt ${relative(root, receiptPath)}`);
}

function resolveReceiptPath(value) {
  const candidate = resolve(root, value);
  if (!isWithin(candidate, root))
    throw new Error(`receipt path must remain inside the repository: ${value}`);
  const actualRoot = realpathSync(root);
  let existing = candidate;
  while (!existsSync(existing) && existing !== root)
    existing = dirname(existing);
  if (!isWithin(realpathSync(existing), actualRoot)) {
    throw new Error(
      `receipt path traverses a symlink outside the repository: ${value}`
    );
  }
  return candidate;
}

function isWithin(path, parent) {
  const resolvedPath = resolve(path);
  const resolvedParent = resolve(parent);
  return (
    resolvedPath === resolvedParent ||
    resolvedPath.startsWith(`${resolvedParent}${sep}`)
  );
}

function toPosix(path) {
  return path.split(sep).join("/");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function passed(name, detail) {
  return { name, status: "passed", ...(detail ? { detail } : {}) };
}

function skipped(name, detail) {
  return { name, status: "skipped", ...(detail ? { detail } : {}) };
}
