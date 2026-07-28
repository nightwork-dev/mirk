import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const root = process.cwd();
const failures = [];
const markdownFiles = [
  "README.md",
  "CHANGELOG.md",
  ...markdownUnder("docs"),
  ...packageDirectories().map((directory) => join("packages", directory, "README.md")),
].filter((file) => existsSync(resolve(root, file)));

for (const file of markdownFiles) {
  const text = readFileSync(resolve(root, file), "utf8");
  checkRelativeLinks(file, text);
  checkPublicSurface(file, text);
}

const packages = packageDirectories().map((directory) => {
  const path = join("packages", directory, "package.json");
  return { directory, path, manifest: JSON.parse(readFileSync(resolve(root, path), "utf8")) };
}).filter(({ manifest }) => manifest.private !== true);

const rootReadme = readFileSync(resolve(root, "README.md"), "utf8");
for (const { directory, manifest } of packages) {
  checkPublicSurface(join("packages", directory, "package.json"), JSON.stringify(manifest, null, 2));
  const readme = join("packages", directory, "README.md");
  if (!existsSync(resolve(root, readme))) {
    failures.push(`${readme}: missing README for public package ${manifest.name}`);
    continue;
  }
  if (!rootReadme.includes(`\`${manifest.name}\``)) {
    failures.push(`README.md: public package inventory omits ${manifest.name}`);
  }
  if (manifest.publishConfig?.registry !== "https://registry.npmjs.org") {
    failures.push(`${join("packages", directory, "package.json")}: public package must target npmjs`);
  }
  if (!manifest.description || !manifest.repository || !manifest.homepage || !manifest.bugs) {
    failures.push(`${join("packages", directory, "package.json")}: incomplete public package metadata`);
  }

  const packageReadme = readFileSync(resolve(root, readme), "utf8");
  for (const exportPath of Object.keys(manifest.exports ?? {})) {
    const publicImport = exportPath === "." ? manifest.name : `${manifest.name}${exportPath.slice(1)}`;
    if (!packageReadme.includes(publicImport)) {
      failures.push(`${readme}: does not document exported entry ${publicImport}`);
    }
  }
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`docs:check: ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`docs:check: ${markdownFiles.length} Markdown files and ${packages.length} public packages passed`);
}

function markdownUnder(directory) {
  const absolute = resolve(root, directory);
  if (!existsSync(absolute)) return [];
  return readdirSync(absolute, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return markdownUnder(path);
    return entry.isFile() && entry.name.endsWith(".md") ? [path] : [];
  });
}

function packageDirectories() {
  return readdirSync(resolve(root, "packages"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(resolve(root, "packages", entry.name, "package.json")))
    .map((entry) => entry.name)
    .sort();
}

function checkRelativeLinks(file, text) {
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

function checkPublicSurface(file, text) {
  const forbidden = [
    { pattern: /\/Users\/[^/\s)]+/g, label: "local macOS home path" },
    { pattern: /\/home\/[^/\s)]+/g, label: "local Unix home path" },
    { pattern: /[A-Za-z]:\\Users\\/g, label: "local Windows home path" },
    { pattern: /\bfile:\/\//gi, label: "local file URL" },
    { pattern: /\bdocs\.local\//g, label: "private docs.local path" },
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
