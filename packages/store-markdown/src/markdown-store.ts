import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import type { StoreFilter, StoreMeta, SyncStore } from "@mirk/store/kv";
import { Document, isMap, parseDocument } from "yaml";

export interface MarkdownSectionConfig {
  heading: string;
  level?: number;
  parse?: (markdown: string) => unknown;
  stringify?: (value: unknown) => string;
}

export interface MarkdownBodyConfig {
  field?: string;
  preambleField?: string;
  sections?: Record<string, MarkdownSectionConfig>;
}

export interface MarkdownIndexConfig {
  fileName?: string;
  heading?: string;
  renderLine: (item: Readonly<Record<string, unknown>>) => string;
}

export interface MarkdownCollectionConfig {
  directory?: string;
  frontmatterFields?: readonly string[] | "all";
  body?: MarkdownBodyConfig;
  fileName?: (item: Readonly<Record<string, unknown>>) => string;
  index?: MarkdownIndexConfig | false;
}

export interface MarkdownMutation {
  operation: "set" | "delete" | "put" | "remove";
  key?: string;
  collection?: string;
  id?: string;
}

export interface MarkdownGitConfig {
  name?: string;
  email?: string;
  message?: (mutation: Readonly<MarkdownMutation>) => string;
}

export interface MarkdownStoreOptions {
  rootDir: string;
  collections?: Record<string, MarkdownCollectionConfig>;
  git?: boolean | MarkdownGitConfig;
}

export class MarkdownStoreCorruptionError extends Error {
  readonly errors: readonly Error[];

  constructor(errors: readonly Error[]) {
    super(`Markdown store contains ${errors.length} corrupt record${errors.length === 1 ? "" : "s"}: ${errors.map((error) => error.message).join("; ")}`);
    this.name = "MarkdownStoreCorruptionError";
    this.errors = errors;
  }
}

interface ParsedRecord {
  item: Record<string, unknown>;
  path: string;
  raw: string;
}

const KV_COLLECTION = ".mirk-kv";

export class MarkdownStore implements SyncStore {
  readonly meta: StoreMeta = { backend: "markdown" };
  readonly rootDir: string;

  private readonly collections: Record<string, MarkdownCollectionConfig>;
  private readonly gitConfig: MarkdownGitConfig | null;
  private gitAvailable = false;
  private tempCounter = 0;

  constructor(options: MarkdownStoreOptions) {
    this.rootDir = resolve(options.rootDir);
    this.collections = options.collections ?? {};
    this.gitConfig = options.git === false || options.git === undefined
      ? null
      : options.git === true ? {} : options.git;
    mkdirSync(this.rootDir, { recursive: true });
    this.initializeGit();
  }

  get<T>(key: string): T | null {
    const record = this.readKvRecord(key);
    return record === null ? null : record.item.value as T;
  }

  set<T>(key: string, value: T): void {
    const directory = join(this.rootDir, KV_COLLECTION);
    mkdirSync(directory, { recursive: true });
    const path = join(directory, `${encodeName(key)}.md`);
    const existing = existsSync(path) ? this.parseRecord(path, defaultConfig()) : undefined;
    this.writeRecord(path, { id: key, value }, defaultConfig(), existing?.raw);
    this.commit({ operation: "set", key });
  }

  has(key: string): boolean {
    return this.readKvRecord(key) !== null;
  }

  delete(key: string): boolean {
    const path = join(this.rootDir, KV_COLLECTION, `${encodeName(key)}.md`);
    if (!existsSync(path)) return false;
    rmSync(path);
    this.commit({ operation: "delete", key });
    return true;
  }

  keys(prefix?: string): string[] {
    const directory = join(this.rootDir, KV_COLLECTION);
    if (!existsSync(directory)) return [];
    const records = this.readDirectory(directory, defaultConfig());
    return records
      .map((record) => String(record.item.id))
      .filter((key) => prefix === undefined || key.startsWith(prefix))
      .sort((left, right) => left.localeCompare(right));
  }

  list<T>(collection: string, filter?: StoreFilter): T[] {
    const records = this.readCollection(collection);
    return applyFilter(records.map((record) => record.item as T), filter);
  }

  getById<T>(collection: string, id: string): T | null {
    const config = this.configFor(collection);
    const directory = this.directoryFor(collection, config);
    if (!existsSync(directory)) return null;
    if (config.fileName === undefined) {
      const path = join(directory, `${encodeName(id)}.md`);
      return existsSync(path) ? this.parseRecord(path, config).item as T : null;
    }
    return this.readDirectory(directory, config).find((record) => record.item.id === id)?.item as T ?? null;
  }

  put<T extends { id: string }>(collection: string, item: T): T {
    assertRecordId(item.id);
    const config = this.configFor(collection);
    const directory = this.directoryFor(collection, config);
    mkdirSync(directory, { recursive: true });
    const records = this.readDirectory(directory, config);
    const existing = records.find((record) => record.item.id === item.id);
    const path = existing?.path ?? join(directory, this.newFileName(item, config));
    if (existing === undefined && existsSync(path)) {
      const occupant = this.parseRecord(path, config);
      throw new Error(`Markdown filename collision: ${path} already belongs to record ${String(occupant.item.id)}.`);
    }
    this.writeRecord(path, item as Record<string, unknown>, config, existing?.raw);
    this.regenerateIndex(collection, config);
    this.commit({ operation: "put", collection, id: item.id });
    return item;
  }

  remove(collection: string, id: string): boolean {
    const config = this.configFor(collection);
    const records = this.readCollection(collection);
    const existing = records.find((record) => record.item.id === id);
    if (existing === undefined) return false;
    rmSync(existing.path);
    this.regenerateIndex(collection, config);
    this.commit({ operation: "remove", collection, id });
    return true;
  }

  count(collection: string, filter?: StoreFilter): number {
    return this.list(collection, filter).length;
  }

  private readKvRecord(key: string): ParsedRecord | null {
    const path = join(this.rootDir, KV_COLLECTION, `${encodeName(key)}.md`);
    return existsSync(path) ? this.parseRecord(path, defaultConfig()) : null;
  }

  private configFor(collection: string): MarkdownCollectionConfig {
    return this.collections[collection] ?? defaultConfig();
  }

  private directoryFor(collection: string, config: MarkdownCollectionConfig): string {
    return joinWithin(this.rootDir, config.directory ?? encodeName(collection));
  }

  private readCollection(collection: string): ParsedRecord[] {
    const config = this.configFor(collection);
    const directory = this.directoryFor(collection, config);
    return existsSync(directory) ? this.readDirectory(directory, config) : [];
  }

  private readDirectory(directory: string, config: MarkdownCollectionConfig): ParsedRecord[] {
    const indexName = config.index === false ? undefined : config.index?.fileName ?? "INDEX.md";
    const records: ParsedRecord[] = [];
    const errors: Error[] = [];
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".md") || entry.name === indexName) continue;
      const path = join(directory, entry.name);
      try {
        records.push(this.parseRecord(path, config));
      } catch (error) {
        errors.push(error instanceof Error ? error : new Error(String(error)));
      }
    }
    if (errors.length > 0) throw new MarkdownStoreCorruptionError(errors);
    return records.sort((left, right) => String(left.item.id).localeCompare(String(right.item.id)));
  }

  private parseRecord(path: string, config: MarkdownCollectionConfig): ParsedRecord {
    const raw = readFileSync(path, "utf8").replace(/^\uFEFF/, "");
    const parsed = parseFrontmatter(raw, path);
    const data = parsed.document.toJS() as unknown;
    if (!isPlainRecord(data) || typeof data.id !== "string" || data.id.length === 0) {
      throw new Error(`${path}: frontmatter must contain a non-empty string id`);
    }
    const item: Record<string, unknown> = { ...data };
    const body = config.body;
    if (body?.field !== undefined) item[body.field] = parsed.body.replace(/\n$/, "");
    if (body?.preambleField !== undefined) item[body.preambleField] = readPreamble(parsed.body);
    for (const [field, section] of Object.entries(body?.sections ?? {})) {
      const markdown = readSection(parsed.body, section);
      item[field] = section.parse?.(markdown) ?? markdown;
    }
    return { item, path, raw };
  }

  private writeRecord(
    path: string,
    item: Record<string, unknown>,
    config: MarkdownCollectionConfig,
    existingRaw?: string,
  ): void {
    const parsed = existingRaw === undefined
      ? { document: new Document({}), body: "" }
      : parseFrontmatter(existingRaw, path);
    if (!isMap(parsed.document.contents)) parsed.document.contents = parsed.document.createNode({});
    const configuredFields = config.frontmatterFields === undefined || config.frontmatterFields === "all"
      ? Object.keys(item)
      : ["id", ...config.frontmatterFields];
    const bodyFields = new Set([
      config.body?.field,
      config.body?.preambleField,
      ...Object.keys(config.body?.sections ?? {}),
    ].filter((field): field is string => field !== undefined));
    for (const field of new Set(configuredFields)) {
      if (bodyFields.has(field)) continue;
      const value = item[field];
      if (value === undefined) parsed.document.delete(field);
      else parsed.document.set(field, value);
    }
    let body = parsed.body;
    if (config.body?.field !== undefined) body = stringifyBody(item[config.body.field]);
    if (config.body?.preambleField !== undefined) {
      body = writePreamble(body, stringifyBody(item[config.body.preambleField]));
    }
    for (const [field, section] of Object.entries(config.body?.sections ?? {})) {
      const value = item[field];
      const markdown = section.stringify?.(value) ?? stringifyBody(value);
      body = writeSection(body, section, markdown);
    }
    const yaml = parsed.document.toString({ lineWidth: 0 }).trimEnd();
    const renderedBody = body.replace(/^\n+/, "");
    const output = `---\n${yaml}\n---\n${renderedBody.length > 0 ? `\n${renderedBody}${renderedBody.endsWith("\n") ? "" : "\n"}` : ""}`;
    this.atomicWrite(path, output);
  }

  private newFileName(item: Record<string, unknown>, config: MarkdownCollectionConfig): string {
    const candidate = config.fileName?.(item) ?? `${encodeName(String(item.id))}.md`;
    if (basename(candidate) !== candidate || !candidate.endsWith(".md") || candidate === "INDEX.md") {
      throw new Error(`Unsafe markdown record filename: ${JSON.stringify(candidate)}`);
    }
    return candidate;
  }

  private regenerateIndex(collection: string, config: MarkdownCollectionConfig): void {
    if (config.index === false || config.index === undefined) return;
    const directory = this.directoryFor(collection, config);
    const items = this.readDirectory(directory, config).map((record) => record.item);
    const heading = config.index.heading ?? collection;
    const lines = items.map((item) => config.index === false || config.index === undefined ? "" : config.index.renderLine(item));
    const output = `# ${heading}\n${lines.length > 0 ? `\n${lines.join("\n")}\n` : ""}`;
    this.atomicWrite(join(directory, config.index.fileName ?? "INDEX.md"), output);
  }

  private atomicWrite(path: string, contents: string): void {
    mkdirSync(dirname(path), { recursive: true });
    const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${this.tempCounter++}.tmp`);
    try {
      writeFileSync(temporary, contents, { encoding: "utf8", flag: "wx" });
      renameSync(temporary, path);
    } finally {
      if (existsSync(temporary)) rmSync(temporary);
    }
  }

  private initializeGit(): void {
    if (this.gitConfig === null) return;
    try {
      if (!existsSync(join(this.rootDir, ".git"))) {
        execFileSync("git", ["-C", this.rootDir, "init"], { stdio: "ignore" });
      }
      execFileSync("git", ["-C", this.rootDir, "rev-parse", "--git-dir"], { stdio: "ignore" });
      this.gitAvailable = true;
    } catch {
      this.gitAvailable = false;
    }
  }

  private commit(mutation: MarkdownMutation): void {
    if (!this.gitAvailable || this.gitConfig === null) return;
    const message = this.gitConfig.message?.(mutation) ?? defaultCommitMessage(mutation);
    const name = this.gitConfig.name ?? "Mirk Markdown Store";
    const email = this.gitConfig.email ?? "store-markdown@mirk.local";
    try {
      execFileSync("git", ["-C", this.rootDir, "add", "-A"], { stdio: "ignore" });
      execFileSync("git", ["-C", this.rootDir, "-c", `user.name=${name}`, "-c", `user.email=${email}`, "commit", "--quiet", "-m", message], { stdio: "ignore" });
    } catch {
      // File persistence is authoritative; unavailable or empty git commits are non-fatal.
    }
  }
}

function defaultConfig(): MarkdownCollectionConfig {
  return { frontmatterFields: "all", index: false };
}

function parseFrontmatter(raw: string, path: string): { document: Document; body: string } {
  if (!raw.startsWith("---\n")) throw new Error(`${path}: missing YAML frontmatter opening delimiter`);
  const end = raw.indexOf("\n---", 4);
  if (end === -1) throw new Error(`${path}: missing YAML frontmatter closing delimiter`);
  const document = parseDocument(raw.slice(4, end), { keepSourceTokens: true, prettyErrors: true });
  if (document.errors.length > 0) throw new Error(`${path}: ${document.errors.map((error) => error.message).join("; ")}`);
  return { document, body: raw.slice(end + 4).replace(/^\n/, "") };
}

function encodeName(value: string): string {
  if (/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) && value !== "." && value !== "..") return value;
  return `~${Buffer.from(value).toString("base64url")}`;
}

function joinWithin(root: string, relative: string): string {
  const path = resolve(root, relative);
  if (path !== root && !path.startsWith(`${root}/`)) throw new Error(`Path escapes markdown store root: ${relative}`);
  return path;
}

function assertRecordId(id: string): void {
  if (typeof id !== "string" || id.length === 0 || id.includes("\0")) throw new Error("Markdown record id must be a non-empty string.");
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringifyBody(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") throw new Error("Markdown body fields must serialize to strings unless a section stringify function is configured.");
  return value.trim();
}

function headingLine(section: MarkdownSectionConfig): string {
  return `${"#".repeat(section.level ?? 2)} ${section.heading}`;
}

function readPreamble(body: string): string {
  const firstHeading = body.split("\n").findIndex((line) => /^#{1,6}\s/.test(line));
  return (firstHeading === -1 ? body : body.split("\n").slice(0, firstHeading).join("\n")).trim();
}

function writePreamble(body: string, value: string): string {
  const lines = body.split("\n");
  const firstHeading = lines.findIndex((line) => /^#{1,6}\s/.test(line));
  const suffix = firstHeading === -1 ? [] : lines.slice(firstHeading);
  return [value, ...suffix].filter((part) => part.length > 0).join("\n\n");
}

function readSection(body: string, section: MarkdownSectionConfig): string {
  const lines = body.split("\n");
  const marker = headingLine(section);
  const start = lines.findIndex((line) => line.trimEnd() === marker);
  if (start === -1) return "";
  const level = section.level ?? 2;
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    const match = /^(#{1,6})\s/.exec(lines[index] ?? "");
    if (match !== null && match[1]!.length <= level) { end = index; break; }
  }
  return lines.slice(start + 1, end).join("\n").trim();
}

function writeSection(body: string, section: MarkdownSectionConfig, value: string): string {
  const lines = body.length === 0 ? [] : body.split("\n");
  const marker = headingLine(section);
  const start = lines.findIndex((line) => line.trimEnd() === marker);
  const replacement = [marker, "", ...value.split("\n")];
  if (start === -1) return [...lines, ...(lines.length > 0 ? [""] : []), ...replacement].join("\n");
  const level = section.level ?? 2;
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    const match = /^(#{1,6})\s/.exec(lines[index] ?? "");
    if (match !== null && match[1]!.length <= level) { end = index; break; }
  }
  return [...lines.slice(0, start), ...replacement, "", ...lines.slice(end)].join("\n");
}

function applyFilter<T>(items: T[], filter?: StoreFilter): T[] {
  let result = items;
  if (filter?.where !== undefined) {
    result = result.filter((item) => isPlainRecord(item) && Object.entries(filter.where ?? {}).every(([key, value]) => Object.hasOwn(item, key) && item[key] === value));
  }
  if (filter?.sortBy !== undefined) {
    const field = filter.sortBy;
    const direction = filter.sortDir === "desc" ? -1 : 1;
    result = [...result].sort((left, right) => {
      const leftValue = isPlainRecord(left) ? left[field] : undefined;
      const rightValue = isPlainRecord(right) ? right[field] : undefined;
      if (leftValue === rightValue) return 0;
      if (leftValue === undefined || leftValue === null) return 1;
      if (rightValue === undefined || rightValue === null) return -1;
      return leftValue < rightValue ? -direction : direction;
    });
  }
  if ((filter?.offset ?? 0) > 0) result = result.slice(filter?.offset);
  if (filter?.limit !== undefined && filter.limit >= 0) result = result.slice(0, filter.limit);
  return result;
}

function defaultCommitMessage(mutation: MarkdownMutation): string {
  if (mutation.operation === "set" || mutation.operation === "delete") return `kv ${mutation.key}: ${mutation.operation}`;
  return `${mutation.collection} ${mutation.id}: ${mutation.operation}`;
}
