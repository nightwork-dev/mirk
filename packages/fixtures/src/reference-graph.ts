import { parseRef } from "./refs.js";
import type { Diagnostic, ReferenceGraph, ReferenceGraphNode, ExtractedReference } from "./types.js";

export interface GraphBuildEntry {
  ref: string;
  value: unknown;
  resolved: boolean;
  refs: ReadonlyArray<ExtractedReference>;
}

export function buildReferenceGraph(
  entries: ReadonlyArray<GraphBuildEntry>,
  diagnostics: readonly Diagnostic[] = [],
): ReferenceGraph {
  const nodes = new Map<string, ReferenceGraphNode>();
  const edges: ReferenceGraph["edges"] = [];

  for (const entry of entries) {
    addNode(nodes, entry.ref, entry.resolved);
    if (!entry.resolved) continue;

    for (const ref of entry.refs) {
      addNode(nodes, ref.ref, false);
      edges.push({ from: entry.ref, to: ref.ref, fieldPath: ref.fieldPath });
    }
  }

  const resolved = new Set(entries.filter((entry) => entry.resolved).map((entry) => entry.ref));
  for (const node of nodes.values()) {
    if (resolved.has(node.ref)) node.resolved = true;
  }

  return { nodes, edges, diagnostics: [...diagnostics] };
}

function addNode(nodes: Map<string, ReferenceGraphNode>, ref: string, resolved: boolean): void {
  const existing = nodes.get(ref);
  if (existing) {
    if (resolved) existing.resolved = true;
    return;
  }

  let type = "<malformed>";
  let id = ref;
  try {
    const parsed = parseRef(ref);
    type = parsed.type;
    id = parsed.id;
  } catch {
    // Malformed refs stay visible as unresolved nodes.
  }

  nodes.set(ref, { ref, type, id, resolved });
}
