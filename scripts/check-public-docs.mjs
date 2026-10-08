import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function checkPublicDocs(root = process.cwd()) {
  const failures = [];
  const typescriptDirectories = packageDirectories(root);
  const pythonDirectories = pythonWorkspaceDirectories(root);
  const markdownFiles = [
    "README.md",
    "CHANGELOG.md",
    "CONTRIBUTING.md",
    ...markdownUnder(root, "docs"),
    ...markdownUnder(root, "conformance"),
    ...typescriptDirectories.map((directory) => join("packages", directory, "README.md")),
    ...pythonDirectories.map((directory) => join("python", directory, "README.md")),
  ].filter((file) => existsSync(resolve(root, file)));

  for (const file of markdownFiles) {
    const text = readFileSync(resolve(root, file), "utf8");
    checkRelativeLinks(root, failures, file, text);
    checkPublicSurface(failures, file, text);
  }

  const packages = typescriptDirectories.map((directory) => {
    const path = join("packages", directory, "package.json");
    return { directory, path, manifest: JSON.parse(readFileSync(resolve(root, path), "utf8")) };
  }).filter(({ manifest }) => manifest.private !== true);

  const rootReadmePath = resolve(root, "README.md");
  if (!existsSync(rootReadmePath)) {
    failures.push("README.md: missing root README");
  }
  const rootReadme = existsSync(rootReadmePath) ? readFileSync(rootReadmePath, "utf8") : "";

  for (const { directory, manifest } of packages) {
    const manifestPath = join("packages", directory, "package.json");
    checkPublicSurface(failures, manifestPath, JSON.stringify(manifest, null, 2));
    const readme = join("packages", directory, "README.md");
    if (!existsSync(resolve(root, readme))) {
      failures.push(`${readme}: missing README for public package ${manifest.name}`);
      continue;
    }
    if (!rootReadme.includes(`\`${manifest.name}\``)) {
      failures.push(`README.md: public package inventory omits ${manifest.name}`);
    }
    if (manifest.publishConfig?.registry !== "https://registry.npmjs.org") {
      failures.push(`${manifestPath}: public package must target npmjs`);
    }
    if (!manifest.description || !manifest.repository || !manifest.homepage || !manifest.bugs) {
      failures.push(`${manifestPath}: incomplete public package metadata`);
    }

    const packageReadme = readFileSync(resolve(root, readme), "utf8");
    for (const exportPath of Object.keys(manifest.exports ?? {})) {
      const publicImport = exportPath === "." ? manifest.name : `${manifest.name}${exportPath.slice(1)}`;
      if (!packageReadme.includes(publicImport)) {
        failures.push(`${readme}: does not document exported entry ${publicImport}`);
      }
    }
  }

  for (const directory of pythonDirectories) {
    const pyproject = join("python", directory, "pyproject.toml");
    if (!existsSync(resolve(root, pyproject))) {
      failures.push(`${pyproject}: missing Python package metadata`);
      continue;
    }
    const text = readFileSync(resolve(root, pyproject), "utf8");
    checkPublicSurface(failures, pyproject, text);
    const name = tomlString(text, "name");
    const description = tomlString(text, "description");
    const version = tomlString(text, "version");
    const readme = join("python", directory, "README.md");
    if (!name || !description || !version) {
      failures.push(`${pyproject}: incomplete public package metadata`);
    }
    if (!existsSync(resolve(root, readme))) {
      failures.push(`${readme}: missing README for Python package ${name ?? directory}`);
      continue;
    }
    if (name && !rootReadme.includes(`\`${name}\``)) {
      failures.push(`README.md: Python package inventory omits ${name}`);
    }
  }

  return { failures, markdownFiles, packages, pythonDirectories };
}

function markdownUnder(root, directory) {
  const absolute = resolve(root, directory);
  if (!existsSync(absolute)) return [];
  return readdirSync(absolute, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return markdownUnder(root, path);
    return entry.isFile() && entry.name.endsWith(".md") ? [path] : [];
  });
}

function packageDirectories(root) {
  const directory = resolve(root, "packages");
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(resolve(root, "packages", entry.name, "package.json")))
    .map((entry) => entry.name)
    .sort();
}

function pythonWorkspaceDirectories(root) {
  const path = resolve(root, "python", "pyproject.toml");
  if (!existsSync(path)) return [];
  const text = readFileSync(path, "utf8");
  const members = text.match(/members\s*=\s*\[([\s\S]*?)\]/)?.[1] ?? "";
  return [...members.matchAll(/"([^"\n]+)"/g)].map((match) => match[1]);
}

function tomlString(text, key) {
  return text.match(new RegExp(`^${key}\\s*=\\s*"([^"]*)"`, "m"))?.[1];
}

function checkRelativeLinks(root, failures, file, text) {
  for (const match of text.matchAll(/!?\[[^\]]*]\(([^)]+)\)/g)) {
    let target = match[1].trim();
    if (target.startsWith("<")) {
      const closing = target.indexOf(">");
      target = closing === -1 ? target : target.slice(1, closing);
    } else {
      target = target.split(/\s+["']/)[0];
    }
    target = target.split("#")[0];
    if (!target || target.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue;

    let decoded;
    try {
      decoded = decodeURIComponent(target);
    } catch {
      failures.push(`${file}: malformed relative link ${target}`);
      continue;
    }
    const destination = resolve(root, dirname(file), decoded);
    if (!existsSync(destination)) {
      failures.push(`${file}: broken relative link ${target} -> ${relative(root, destination)}`);
    }
  }
}

function checkPublicSurface(failures, file, text) {
  const forbidden = [
    { pattern: /\/Users\/[^/\s)]+/g, label: "local macOS home path" },
    { pattern: /\/home\/[^/\s)]+/g, label: "local Unix home path" },
    { pattern: /[A-Za-z]:\\Users\\/g, label: "local Windows home path" },
    { pattern: /\bfile:\/\//gi, label: "local file URL" },
    { pattern: /\bdocs\.local\//g, label: "private docs.local path" },
    { pattern: /\b(?:localhost|127\.0\.0\.1):4873\b/g, label: "local npm registry" },
    { pattern: /\brelease candidate\b/gi, label: "stale release-candidate marker" },
    { pattern: /\bimplemented, pre-release\b/gi, label: "stale pre-release marker" },
    { pattern: /status-draft/gi, label: "stale draft badge" },
    { pattern: /until the first tagged release/gi, label: "stale first-release marker" },
  ];

  for (const { pattern, label } of forbidden) {
    for (const match of text.matchAll(pattern)) {
      const line = text.slice(0, match.index).split("\n").length;
      failures.push(`${file}:${line}: ${label}`);
    }
  }
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const result = checkPublicDocs();
  if (result.failures.length > 0) {
    for (const failure of result.failures) console.error(`docs:check: ${failure}`);
    process.exitCode = 1;
  } else {
    console.log(
      `docs:check: ${result.markdownFiles.length} Markdown files, ` +
        `${result.packages.length} public packages, and ` +
        `${result.pythonDirectories.length} Python packages passed`,
    );
  }
}
