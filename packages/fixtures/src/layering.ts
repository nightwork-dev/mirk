import type {
  FixtureProvenanceLayer,
  FixtureSource,
  LayeredSource,
  MergeContext,
  MergeStrategy,
  PatchDocument,
} from "./types.js";

export interface NormalizedLayeredSource extends LayeredSource {
  order: number;
}

function isLayeredSource(source: FixtureSource | LayeredSource): source is LayeredSource {
  return "source" in source && typeof source.source === "object";
}

export function normalizeLayers(sources: ReadonlyArray<FixtureSource | LayeredSource>): NormalizedLayeredSource[] {
  return sources.map((entry, index) => {
    if (isLayeredSource(entry)) {
      return { ...entry, order: index };
    }
    return { source: entry, layer: entry.id, priority: index, order: index };
  }).sort((a, b) => a.priority - b.priority || a.order - b.order);
}

export function isPatchDocument(value: unknown): value is PatchDocument {
  return typeof value === "object"
    && value !== null
    && !Array.isArray(value)
    && typeof (value as { $patch?: unknown }).$patch === "string";
}

export function patchBody(doc: PatchDocument): Record<string, unknown> {
  const { $patch: _patch, ...body } = doc;
  void _patch;
  return body;
}

export function mergeWithStrategy(
  strategy: MergeStrategy | undefined,
  existing: unknown,
  incoming: unknown,
  ctx: MergeContext,
  replaced?: (path: string, value: unknown) => void,
): unknown {
  if (typeof strategy === "function") return strategy(existing, incoming, ctx);

  switch (strategy ?? "replace") {
    case "replace":
      replaced?.("", incoming);
      return cloneJsonish(incoming);
    case "deep":
      return deepMerge(existing, incoming, replaced);
    case "array-replace":
      return shallowObjectMerge(existing, incoming, replaced);
  }
}

export function provenanceCtx(layers: ReadonlyArray<FixtureProvenanceLayer>): MergeContext["layers"] {
  return layers.map((layer) => ({
    sourceId: layer.sourceId,
    layer: layer.layer,
    priority: layer.priority,
    kind: layer.kind,
  }));
}

export function pointerPart(value: string): string {
  return value.replace(/~/g, "~0").replace(/\//g, "~1");
}

function deepMerge(existing: unknown, incoming: unknown, replaced?: (path: string, value: unknown) => void, path = ""): unknown {
  if (!isPlainObject(existing) || !isPlainObject(incoming)) {
    replaced?.(path, incoming);
    return cloneJsonish(incoming);
  }

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(existing)) {
    out[key] = cloneJsonish(value);
  }
  for (const [key, value] of Object.entries(incoming)) {
    out[key] = deepMerge(existing[key], value, replaced, `${path}/${pointerPart(key)}`);
  }
  return out;
}

function shallowObjectMerge(existing: unknown, incoming: unknown, replaced?: (path: string, value: unknown) => void): unknown {
  if (!isPlainObject(existing) || !isPlainObject(incoming)) {
    replaced?.("", incoming);
    return cloneJsonish(incoming);
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(existing)) {
    out[key] = cloneJsonish(value);
  }
  for (const [key, value] of Object.entries(incoming)) {
    replaced?.(`/${pointerPart(key)}`, value);
    out[key] = cloneJsonish(value);
  }
  return out;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function cloneJsonish(value: unknown): unknown {
  if (typeof value !== "object" || value === null) return value;
  const clone = (globalThis as { structuredClone?: <T>(input: T) => T }).structuredClone;
  if (!clone) {
    throw new TypeError("Fixture merge values require structuredClone support.");
  }
  return clone(value);
}
