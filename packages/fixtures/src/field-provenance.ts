import { pointerPart } from "./layering.js";
import type { FixtureFieldProvenance, FixtureProvenanceLayer } from "./types.js";

export function fieldRecorder(fields: Record<string, FixtureFieldProvenance>, layer: FixtureProvenanceLayer, prefix: string) {
  return (path: string, value: unknown): void => {
    for (const key of Object.keys(fields)) {
      if (path === "" || key === path || key.startsWith(`${path}/`) || path.startsWith(`${key}/`)) delete fields[key];
    }
    function record(value: unknown, path: string): void {
      fields[path] = { ...layer, fieldPath: prefix + path };
      if (value !== null && typeof value === "object") {
        for (const [key, child] of Object.entries(value)) record(child, `${path}/${pointerPart(key)}`);
      }
    }
    record(value, path);
  };
}

export function fieldSnapshot(value: unknown): string | undefined {
  try { return JSON.stringify(value); } catch { return undefined; }
}
