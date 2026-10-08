import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
// The adapter's workspace export points at source. Tooling uses its built entry
// so the store package's production rootDir stays local.
import {
  MarkdownStore,
  MarkdownStoreError,
  MarkdownStoreCorruptionError,
  type MarkdownCollectionConfig,
} from "../../../store-markdown/dist/index.js";
import type { OpenTarget } from "./backends.js";
import type { StoreFilter } from "../kv.js";

export function openMarkdownTarget(): OpenTarget {
  const root = mkdtempSync(join(tmpdir(), "mirk-markdown-conformance-"));
  let store: MarkdownStore;
  const pathFor = (name: string) => {
    const path = resolve(root, name);
    if (path !== root && !path.startsWith(root + sep))
      throw new Error("unsafe corpus path");
    return path;
  };
  const configure = (
    spec: {
      collections?: Record<string, MarkdownCollectionConfig>;
      preset?: string;
      git?: boolean;
      indexFileName?: string;
    } = {}
  ) => {
    for (const file of readdirSync(root))
      rmSync(join(root, file), { force: true, recursive: true });
    const collections =
      spec.preset === "notes"
        ? {
            documents: {
              directory: "docs",
              frontmatterFields: ["title", "status"],
              body: {
                preambleField: "summary",
                sections: { details: { heading: "Details" } },
              },
              fileName: (item: Readonly<Record<string, unknown>>) =>
                `${String(item.title)
                  .toLowerCase()
                  .replace(/[^a-z0-9]+/g, "-")
                  .replace(/^-+|-+$/g, "")}.md`,
              index: {
                heading: "Notes",
                fileName: spec.indexFileName,
                renderLine: (item: Readonly<Record<string, unknown>>) =>
                  `- ${item.id} · ${item.title} · ${item.status}`,
              },
            },
          }
        : spec.collections;
    store = new MarkdownStore({
      rootDir: root,
      collections,
      git: spec.git ?? false,
    });
  };
  configure();
  const api: Record<string, unknown> = {
    configure,
    get: (key: string) => store.get(key),
    set: (key: string, value: unknown) => store.set(key, value),
    has: (key: string) => store.has(key),
    delete: (key: string) => store.delete(key),
    keys: (prefix?: string) => store.keys(prefix),
    list: (collection: string, filter?: StoreFilter) =>
      store.list(collection, filter),
    getById: (collection: string, id: string) => store.getById(collection, id),
    put: (collection: string, item: { id: string }) =>
      store.put(collection, item),
    remove: (collection: string, id: string) => store.remove(collection, id),
    count: (collection: string, filter?: StoreFilter) =>
      store.count(collection, filter),
    writeFile(name: string, contents: string) {
      const path = pathFor(name);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, contents);
    },
    fileContains(name: string, text: string) {
      try {
        return readFileSync(pathFor(name), "utf8").includes(text);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
      }
    },
    files() {
      const files: string[] = [];
      const walk = (directory: string) => {
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
          const path = join(directory, entry.name);
          if (entry.isDirectory()) walk(path);
          else if (entry.isFile() && path.endsWith(".md"))
            files.push(relative(root, path).split(sep).join("/"));
        }
      };
      walk(root);
      return files.sort();
    },
    failure(operation: string, args: unknown[]) {
      try {
        const method = api[operation];
        if (typeof method !== "function")
          throw new Error(`unknown operation: ${operation}`);
        method(...args);
      } catch (error) {
        if (error instanceof MarkdownStoreCorruptionError) {
          return {
            code: "corrupt-records",
            paths: error.errors
              .map((item) => {
                const match = /([^\n]+\.md):/.exec(item.message);
                if (!match) throw item;
                return relative(root, match[1]!).split(sep).join("/");
              })
              .sort(),
          };
        }
        if (error instanceof MarkdownStoreError) return { code: error.code };
        throw error;
      }
      throw new Error("expected an adapter failure");
    },
  };
  return {
    target: { kind: "store_markdown", api },
    dispose: () => rmSync(root, { recursive: true, force: true }),
  };
}
