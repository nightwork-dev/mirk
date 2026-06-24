import { FixtureError } from "../errors.js";
import type { FixtureLoader, FixtureSource, FixtureSourceEntry, LoadedFixture, MaybePromise } from "../types.js";

export interface StoredFixtureItem {
  id: string;
  content: string;
  extension: string;
  relativePath?: string;
  updatedAt?: string;
  meta?: Record<string, unknown>;
}

export interface KvLike<TItem> {
  list<T = TItem>(collection: string): MaybePromise<readonly T[]>;
  getById<T = TItem>(collection: string, id: string): MaybePromise<T | null | undefined>;
}

export interface WritableKvLike<TItem> extends KvLike<TItem> {
  put<T extends { id: string } = TItem & { id: string }>(collection: string, item: T): MaybePromise<T>;
}

export interface StoreFixtureSourceOptions<TItem = StoredFixtureItem> {
  id: string;
  store: KvLike<TItem>;
  collection: string;
  pathPrefix?: string;
  mapItem?: (item: TItem) => StoredFixtureItem;
}

export interface StoreFixtureSource extends FixtureSource {
  invalidate(): void;
}

export interface SeedStoreFromFixturesOptions<TItem extends { id: string } = SeededFixtureItem> {
  loader: FixtureLoader;
  store: WritableKvLike<TItem>;
  targets: Record<string, string>;
  mode?: "upsert" | "insert-only";
  includeProvenance?: boolean;
  validateBeforeWrite?: boolean;
  mapItem?: (fixture: LoadedFixture) => TItem;
}

export interface SeededFixtureItem {
  id: string;
  value: unknown;
  provenance?: LoadedFixture["provenance"];
}

export interface SeedStoreResult {
  written: Array<{ type: string; ref: string; collection: string; id: string }>;
  skipped: Array<{ type: string; ref: string; collection: string; id: string; reason: string }>;
}

export function createStoreFixtureSource<TItem = StoredFixtureItem>(
  opts: StoreFixtureSourceOptions<TItem>,
): StoreFixtureSource {
  let cache: StoredFixtureItem[] | undefined;
  const itemByLocator = new Map<string, StoredFixtureItem>();

  async function loadItems(): Promise<StoredFixtureItem[]> {
    if (cache) return cache;
    const raw = await opts.store.list<TItem>(opts.collection);
    const mapped = raw.map((item) => opts.mapItem ? opts.mapItem(item) : item as unknown as StoredFixtureItem);
    const seenPaths = new Set<string>();
    const nextItemByLocator = new Map<string, StoredFixtureItem>();

    for (const item of mapped) {
      const relativePath = relativePathFor(item, opts.pathPrefix);
      if (seenPaths.has(relativePath)) {
        throw new FixtureError({
          severity: "error",
          code: "duplicate-relative-path",
          message: `Store source "${opts.id}" produced duplicate relative path "${relativePath}".`,
          source: opts.id,
          path: relativePath,
        });
      }
      seenPaths.add(relativePath);
      nextItemByLocator.set(item.id, item);
    }

    cache = [...mapped].sort((a, b) => {
      const aPath = relativePathFor(a, opts.pathPrefix);
      const bPath = relativePathFor(b, opts.pathPrefix);
      return aPath.localeCompare(bPath) || a.id.localeCompare(b.id);
    });
    itemByLocator.clear();
    for (const [locator, item] of nextItemByLocator) itemByLocator.set(locator, item);
    return cache;
  }

  return {
    id: opts.id,
    async list(): Promise<FixtureSourceEntry[]> {
      const items = await loadItems();
      return items.map((item) => ({ relativePath: relativePathFor(item, opts.pathPrefix), locator: item.id }));
    },
    async read(entry: FixtureSourceEntry): Promise<string> {
      await loadItems();
      const item = itemByLocator.get(entry.locator);
      if (!item || relativePathFor(item, opts.pathPrefix) !== entry.relativePath) {
        throw new FixtureError({
          severity: "error",
          code: "source-read-failed",
          message: `Store source "${opts.id}" has no listed entry "${entry.relativePath}".`,
          source: opts.id,
          path: entry.relativePath,
        });
      }
      return item.content;
    },
    invalidate(): void {
      cache = undefined;
      itemByLocator.clear();
    },
  };
}

export async function seedStoreFromFixtures<TItem extends { id: string } = SeededFixtureItem>(
  opts: SeedStoreFromFixturesOptions<TItem>,
): Promise<SeedStoreResult> {
  const mode = opts.mode ?? "upsert";
  const pending: Array<{ type: string; collection: string; fixture: LoadedFixture; item: TItem }> = [];

  for (const [type, collection] of Object.entries(opts.targets)) {
    const refs = await opts.loader.list(type);
    for (const ref of refs) {
      if (opts.validateBeforeWrite !== false) {
        const report = await opts.loader.validate(ref);
        if (!report.ok) {
          throw new FixtureError({
            severity: "error",
            code: "seed-validation-failed",
            message: `Fixture "${ref}" failed validation before store seeding.`,
            fixture: ref,
          });
        }
      }
      const fixture = await opts.loader.loadRaw(ref);
      const item = opts.mapItem ? opts.mapItem(fixture) : defaultSeedItem(fixture, opts.includeProvenance) as unknown as TItem;
      pending.push({ type, collection, fixture, item });
    }
  }

  const written: SeedStoreResult["written"] = [];
  const skipped: SeedStoreResult["skipped"] = [];

  for (const entry of pending) {
    if (mode === "insert-only") {
      const existing = await opts.store.getById(entry.collection, entry.item.id);
      if (existing) {
        skipped.push({
          type: entry.type,
          ref: entry.fixture.ref,
          collection: entry.collection,
          id: entry.item.id,
          reason: "exists",
        });
        continue;
      }
    }

    await opts.store.put(entry.collection, entry.item);
    written.push({
      type: entry.type,
      ref: entry.fixture.ref,
      collection: entry.collection,
      id: entry.item.id,
    });
  }

  return { written, skipped };
}

function relativePathFor(item: StoredFixtureItem, pathPrefix: string | undefined): string {
  if (item.relativePath) return normalizePublicPath(item.relativePath, "relativePath");
  const tail = normalizePublicPath(`${item.id}${item.extension}`, "relativePath");
  if (!pathPrefix) return tail;
  return `${normalizePublicPath(pathPrefix, "pathPrefix")}/${tail}`;
}

function normalizePublicPath(value: string, field: string): string {
  const normalized = value.replace(/^\.\//, "").replace(/^\/+/, "").replace(/\/+$/g, "");
  const parts = normalized.split("/");
  if (
    normalized === ""
    || value.includes("\\")
    || value.startsWith("/")
    || /^[A-Za-z]:/.test(value)
    || parts.some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new FixtureError({
      severity: "error",
      code: "unsafe-relative-path",
      message: `Store fixture ${field} "${value}" is not a safe source-relative path.`,
      path: value,
    });
  }
  return normalized;
}

function defaultSeedItem(fixture: LoadedFixture, includeProvenance: boolean | undefined): SeededFixtureItem {
  return {
    id: fixture.id,
    value: fixture.value,
    ...(includeProvenance ? { provenance: fixture.provenance } : {}),
  };
}
