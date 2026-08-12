import { createFixtureLoader } from "./loader.js";
import { diagnosticsFromError } from "./errors.js";
import type {
  Diagnostic,
  FixtureLoader,
  FixtureLoaderOptions,
  ReferenceGraph,
} from "./types.js";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** The stable JSON envelope emitted by the fixture CLI. */
export interface FixtureCliEnvelope<T = unknown> {
  schema: "mirk-fixtures-cli/v1";
  command: string;
  ok: boolean;
  result?: T;
  diagnostics: readonly Diagnostic[];
}

export interface FixtureCliRunOptions {
  /** Working directory used to resolve a relative configuration path. */
  cwd?: string;
  stdout?: { write(chunk: string): unknown };
}

export interface FixtureCliExecution {
  exitCode: 0 | 1 | 2 | 3;
  envelope: FixtureCliEnvelope;
  text: string;
}

interface ParsedArguments {
  command: string;
  configPath: string;
  ref?: string;
  type?: string;
  mode?: "raw" | "materialized";
  format?: "json" | "dot";
  json: boolean;
  debugPaths: boolean;
}

interface FixtureConfigModule {
  default?: unknown;
  registry?: FixtureLoaderOptions["registry"];
  sources?: FixtureLoaderOptions["sources"];
  parsers?: FixtureLoaderOptions["parsers"];
  referenceMode?: FixtureLoaderOptions["referenceMode"];
  loader?: FixtureLoader;
}

const USAGE = `Usage:
  mirk-fixtures validate [config]
  mirk-fixtures list [config] [--type <type>]
  mirk-fixtures show [config] <type:id> [--raw|--materialized]
  mirk-fixtures explain [config] <type:id>
  mirk-fixtures graph [config] [--format json|dot]

Options:
  --json          Emit a versioned JSON envelope
  --debug-paths   Include absolute paths in diagnostics
  --help          Show this help
`;

/**
 * Execute the CLI without calling process.exit. This is useful to embedders
 * and keeps the binary straightforward to test.
 */
export async function executeFixtureCli(
  argv: readonly string[],
  options: FixtureCliRunOptions = {}
): Promise<FixtureCliExecution> {
  const cwd = options.cwd ?? process.cwd();
  const debugPaths = argv.includes("--debug-paths");
  const commandHint =
    typeof argv[0] === "string" && !argv[0].startsWith("-") ? argv[0] : "usage";

  let args: ParsedArguments;
  try {
    args = parseArguments(argv, cwd);
  } catch (error) {
    const diagnostic: Diagnostic = {
      severity: "error",
      code: "usage-error",
      message: error instanceof Error ? error.message : String(error),
    };
    const envelope = makeEnvelope(
      commandHint,
      undefined,
      [diagnostic],
      false,
      debugPaths
    );
    return {
      exitCode: 2,
      envelope,
      text: `${renderDiagnostics(envelope.diagnostics)}\n\n${USAGE.trimEnd()}`,
    };
  }

  if (args.command === "help") {
    const envelope = makeEnvelope(
      "help",
      { usage: USAGE.trimEnd() },
      [],
      true,
      args.debugPaths
    );
    return {
      exitCode: 0,
      envelope,
      text: args.json ? renderJson(envelope) : USAGE.trimEnd(),
    };
  }

  let loader: FixtureLoader;
  try {
    loader = await loadConfiguredLoader(args.configPath);
  } catch (error) {
    const diagnostics = sanitizeDiagnostics(
      [
        {
          severity: "error",
          code: "config-load-failed",
          message: `Could not load fixture configuration: ${messageOf(error)}`,
          path: args.configPath,
        },
      ],
      args.debugPaths
    );
    const envelope = makeEnvelope(
      args.command,
      undefined,
      diagnostics,
      false,
      args.debugPaths
    );
    return {
      exitCode: 2,
      envelope,
      text: args.json
        ? renderJson(envelope)
        : renderDiagnostics(envelope.diagnostics),
    };
  }

  try {
    const operation = await runCommand(loader, args);
    const diagnostics = sanitizeDiagnostics(
      operation.diagnostics,
      args.debugPaths
    );
    const result = sanitizeResult(operation.result, args.debugPaths);
    const ok = diagnostics.every(
      (diagnostic) => diagnostic.severity !== "error"
    );
    const envelope = makeEnvelope(
      args.command,
      result,
      diagnostics,
      ok,
      args.debugPaths
    );
    const exitCode = ok ? 0 : classifyDiagnostics(diagnostics);
    return {
      exitCode,
      envelope,
      text: renderOutput(
        envelope,
        result,
        args.json,
        renderHuman(args.command, result, diagnostics)
      ),
    };
  } catch (error) {
    const diagnostics = sanitizeDiagnostics(
      diagnosticsFromError(undefined, error),
      args.debugPaths
    );
    const envelope = makeEnvelope(
      args.command,
      undefined,
      diagnostics,
      false,
      args.debugPaths
    );
    return {
      exitCode: classifyDiagnostics(diagnostics),
      envelope,
      text: renderOutput(envelope, undefined, args.json),
    };
  }
}

/** Execute the CLI and write exactly one deterministic output document. */
export async function runFixtureCli(
  argv: readonly string[],
  options: FixtureCliRunOptions = {}
): Promise<0 | 1 | 2 | 3> {
  const execution = await executeFixtureCli(argv, options);
  const stdout = options.stdout ?? process.stdout;
  stdout.write(`${execution.text}\n`);
  return execution.exitCode;
}

async function runCommand(
  loader: FixtureLoader,
  args: ParsedArguments
): Promise<{ result?: unknown; diagnostics: Diagnostic[] }> {
  switch (args.command) {
    case "validate": {
      const report = await loader.validate();
      return {
        result: { ok: report.ok, diagnostics: report.diagnostics },
        diagnostics: report.diagnostics,
      };
    }
    case "list": {
      const refs = await loader.list(args.type);
      return {
        result: { refs },
        diagnostics: [],
      };
    }
    case "show": {
      const ref = required(args.ref, "show requires a fixture ref (type:id)");
      if (args.mode === "raw") {
        const loaded = await loader.loadRaw(ref);
        return {
          result: {
            ref: loaded.ref,
            type: loaded.type,
            id: loaded.id,
            mode: "raw",
            value: loaded.value,
            provenance: loaded.provenance,
          },
          diagnostics: [],
        };
      }
      const value = await loader.materialize(ref);
      return {
        result: { ref, mode: "materialized", value },
        diagnostics: [],
      };
    }
    case "explain": {
      const ref = required(
        args.ref,
        "explain requires a fixture ref (type:id)"
      );
      const loaded = await loader.loadRaw(ref);
      return {
        result: loaded.provenance,
        diagnostics: [],
      };
    }
    case "graph": {
      const graph = await loader.referenceGraph();
      const result = serializeGraph(graph);
      return {
        result: args.format === "dot" ? graphToDot(result) : result,
        diagnostics: result.diagnostics,
      };
    }
    default:
      throw new Error(`Unsupported command "${args.command}".`);
  }
}

function parseArguments(argv: readonly string[], cwd: string): ParsedArguments {
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    return {
      command: "help",
      configPath: resolve(cwd, "mirk.fixtures.mjs"),
      json: argv.includes("--json"),
      debugPaths: argv.includes("--debug-paths"),
    };
  }

  const command = argv[0] ?? "";
  if (!["validate", "list", "show", "explain", "graph"].includes(command)) {
    throw new Error(`Unknown command "${command}".`);
  }

  const positionals: string[] = [];
  let json = false;
  let debugPaths = false;
  let type: string | undefined;
  let mode: ParsedArguments["mode"];
  let format: ParsedArguments["format"];

  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg) continue;
    if (arg === "--json") {
      json = true;
    } else if (arg === "--debug-paths") {
      debugPaths = true;
    } else if (arg === "--raw" || arg === "--materialized") {
      const nextMode = arg.slice(2) as "raw" | "materialized";
      if (mode && mode !== nextMode)
        throw new Error("show accepts only one of --raw or --materialized.");
      mode = nextMode;
    } else if (arg === "--type") {
      const value = argv[++index];
      if (!value || value.startsWith("-"))
        throw new Error("--type requires a fixture type.");
      type = value;
    } else if (arg === "--format") {
      const value = argv[++index];
      if (value !== "json" && value !== "dot")
        throw new Error("--format must be json or dot.");
      format = value;
    } else if (arg === "--help" || arg === "-h") {
      return {
        command: "help",
        configPath: resolve(cwd, "mirk.fixtures.mjs"),
        json,
        debugPaths,
      };
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown option "${arg}".`);
    } else {
      positionals.push(arg);
    }
  }

  const configRaw = positionals.shift() ?? "mirk.fixtures.mjs";
  const configPath = resolve(cwd, configRaw);
  if (!configPath.endsWith(".mjs") && !configPath.endsWith(".js")) {
    throw new Error(
      "Fixture configuration must be a JavaScript .mjs or .js module."
    );
  }

  const ref = positionals.shift();
  if (positionals.length > 0)
    throw new Error(`Unexpected argument "${positionals[0]}".`);
  if ((command === "show" || command === "explain") && !ref) {
    throw new Error(`${command} requires a fixture ref (type:id).`);
  }
  if (command !== "list" && type)
    throw new Error(`--type is only valid for list.`);
  if (command !== "graph" && format)
    throw new Error(`--format is only valid for graph.`);
  if (command !== "show" && mode)
    throw new Error(`--raw/--materialized is only valid for show.`);

  return {
    command,
    configPath,
    ref,
    type,
    mode: mode ?? "materialized",
    format: format ?? "json",
    json,
    debugPaths,
  };
}

async function loadConfiguredLoader(
  configPath: string
): Promise<FixtureLoader> {
  const moduleUrl = pathToFileURL(configPath);
  const module = await import(moduleUrl.href);
  const exported = (module.default ?? module) as
    | FixtureConfigModule
    | FixtureLoader;
  if (isLoader(exported)) return exported;

  const candidate =
    exported &&
    typeof exported === "object" &&
    "loader" in exported &&
    exported.loader
      ? exported.loader
      : exported;
  if (isLoader(candidate)) return candidate;
  if (!candidate || typeof candidate !== "object") {
    throw new Error(
      "Configuration must export a FixtureLoader or { registry, sources, parsers }."
    );
  }

  const inputs = candidate as FixtureConfigModule;
  if (
    !inputs.registry ||
    typeof inputs.registry.get !== "function" ||
    typeof inputs.registry.types !== "function"
  ) {
    throw new Error("Configuration is missing a fixture registry.");
  }
  if (!Array.isArray(inputs.sources))
    throw new Error("Configuration is missing a sources array.");
  return createFixtureLoader({
    registry: inputs.registry,
    sources: inputs.sources,
    ...(inputs.parsers ? { parsers: inputs.parsers } : {}),
    ...(inputs.referenceMode ? { referenceMode: inputs.referenceMode } : {}),
  });
}

function isLoader(value: unknown): value is FixtureLoader {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<FixtureLoader>;
  return (
    typeof candidate.load === "function" &&
    typeof candidate.loadRaw === "function" &&
    typeof candidate.materialize === "function" &&
    typeof candidate.list === "function" &&
    typeof candidate.validate === "function" &&
    typeof candidate.referenceGraph === "function"
  );
}

function required(value: string | undefined, message: string): string {
  if (!value) throw new Error(message);
  return value;
}

function makeEnvelope(
  command: string,
  result: unknown,
  diagnostics: readonly Diagnostic[],
  ok: boolean,
  debugPaths: boolean
): FixtureCliEnvelope {
  const envelope: FixtureCliEnvelope = {
    schema: "mirk-fixtures-cli/v1",
    command: debugPaths ? command : redactAbsolutePaths(command),
    ok,
    diagnostics: sanitizeDiagnostics(diagnostics, debugPaths),
  };
  if (result !== undefined)
    envelope.result = sortJson(sanitizeResult(result, debugPaths));
  return envelope;
}

function renderOutput(
  envelope: FixtureCliEnvelope,
  result: unknown,
  json: boolean,
  human?: string
): string {
  if (json) return renderJson(envelope);
  if (human !== undefined) return human;
  if (envelope.diagnostics.length > 0)
    return renderDiagnostics(envelope.diagnostics);
  return result === undefined ? "ok" : renderValue(result);
}

function renderHuman(
  command: string,
  result: unknown,
  diagnostics: readonly Diagnostic[]
): string | undefined {
  switch (command) {
    case "validate": {
      const ok =
        typeof result === "object" && result !== null && "ok" in result
          ? Boolean((result as { ok?: unknown }).ok)
          : diagnostics.every((diagnostic) => diagnostic.severity !== "error");
      return renderValidation(ok, diagnostics);
    }
    case "list": {
      const refs =
        typeof result === "object" &&
        result !== null &&
        "refs" in result &&
        Array.isArray((result as { refs?: unknown }).refs)
          ? [...(result as { refs: unknown[] }).refs].map(String).sort()
          : [];
      return refs.length > 0 ? refs.join("\n") : "(no fixtures)";
    }
    case "show":
      return renderValue(
        typeof result === "object" && result !== null && "value" in result
          ? (result as { value: unknown }).value
          : result
      );
    case "explain":
      return renderProvenance(result);
    case "graph":
      return typeof result === "string" ? result : renderJson(result);
    default:
      return undefined;
  }
}

function renderJson(value: unknown): string {
  return `${JSON.stringify(sortJson(value))}`;
}

function renderValue(value: unknown): string {
  return JSON.stringify(sortJson(value), null, 2) ?? "null";
}

function renderValidation(
  ok: boolean,
  diagnostics: readonly Diagnostic[]
): string {
  const lines = [`ok: ${ok}`];
  if (diagnostics.length > 0) lines.push(renderDiagnostics(diagnostics));
  return lines.join("\n");
}

function renderDiagnostics(diagnostics: readonly Diagnostic[]): string {
  return diagnostics
    .map((diagnostic) => {
      const target = diagnostic.fixture ? ` ${diagnostic.fixture}` : "";
      const location = [
        diagnostic.source,
        diagnostic.path,
        diagnostic.fieldPath,
      ]
        .filter(Boolean)
        .join(" ");
      return `${diagnostic.severity} ${diagnostic.code}${target}: ${
        diagnostic.message
      }${location ? ` (${location})` : ""}`;
    })
    .join("\n");
}

function renderProvenance(provenance: unknown): string {
  const value = provenance as {
    finalRef?: string;
    layers?: readonly Record<string, unknown>[];
  };
  const lines = [`ref: ${value.finalRef ?? "<unknown>"}`, "layers:"];
  for (const layer of value.layers ?? []) {
    lines.push(
      `- ${String(layer.kind)} source=${String(layer.sourceId)} layer=${String(
        layer.layer
      )} priority=${String(layer.priority)} path=${String(layer.path)}`
    );
  }
  return lines.join("\n");
}

interface SerializedGraph {
  nodes: Array<{ ref: string; type: string; id: string; resolved: boolean }>;
  edges: Array<{ from: string; to: string; fieldPath: string[] }>;
  diagnostics: Diagnostic[];
}

function serializeGraph(graph: ReferenceGraph): SerializedGraph {
  const nodes = [...graph.nodes.values()]
    .map((node) => ({
      ref: node.ref,
      type: node.type,
      id: node.id,
      resolved: node.resolved,
    }))
    .sort((a, b) => a.ref.localeCompare(b.ref));
  const edges = graph.edges
    .map((edge) => ({
      from: edge.from,
      to: edge.to,
      fieldPath: edge.fieldPath.map(String),
    }))
    .sort((a, b) =>
      `${a.from}\u0000${a.to}\u0000${a.fieldPath.join(".")}`.localeCompare(
        `${b.from}\u0000${b.to}\u0000${b.fieldPath.join(".")}`
      )
    );
  return { nodes, edges, diagnostics: [...graph.diagnostics] };
}

function graphToDot(graph: SerializedGraph): string {
  const lines = ["digraph fixtures {"];
  for (const node of graph.nodes) {
    const style = node.resolved ? "solid" : "dashed";
    lines.push(
      `  ${dotString(node.ref)} [label=${dotString(node.ref)}, style=${style}];`
    );
  }
  for (const edge of graph.edges) {
    const label = edge.fieldPath.join(".");
    lines.push(
      `  ${dotString(edge.from)} -> ${dotString(edge.to)}${
        label ? ` [label=${dotString(label)}]` : ""
      };`
    );
  }
  lines.push("}");
  return lines.join("\n");
}

function dotString(value: string): string {
  return `"${value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("\n", "\\n")
    .replaceAll("\r", "\\r")}"`;
}

function classifyDiagnostics(diagnostics: readonly Diagnostic[]): 1 | 3 {
  return diagnostics.some(
    (diagnostic) =>
      diagnostic.code === "unknown-error" ||
      diagnostic.code.startsWith("source-")
  )
    ? 3
    : 1;
}

function sanitizeDiagnostics(
  diagnostics: readonly Diagnostic[],
  debugPaths: boolean
): Diagnostic[] {
  return diagnostics
    .map((diagnostic) => {
      if (debugPaths) return { ...diagnostic };
      const result: Diagnostic = { ...diagnostic };
      for (const key of [
        "message",
        "hint",
        "fixture",
        "source",
        "path",
        "fieldPath",
      ] as const) {
        const value = result[key];
        if (typeof value !== "string") continue;
        if (key === "path" && isAbsolute(value)) {
          result[key] = "<redacted>";
        } else {
          result[key] = redactAbsolutePaths(value);
        }
      }
      return result;
    })
    .sort(compareDiagnostics);
}

function sanitizeResult(value: unknown, debugPaths: boolean): unknown {
  if (debugPaths || value === undefined) return value;
  // Preserve the result shape while treating every returned string as
  // untrusted output. This also covers custom loaders and materializers.
  return redactResultPaths(value);
}

function redactResultPaths(
  value: unknown,
  key?: string,
  seen = new WeakSet<object>()
): unknown {
  if (typeof value === "string") return redactAbsolutePaths(value);
  if (key === "diagnostics" && Array.isArray(value))
    return sanitizeDiagnostics(value as Diagnostic[], false);
  if (!value || typeof value !== "object") return value;
  if (seen.has(value))
    throw new TypeError("CLI output contains a cyclic value.");
  seen.add(value);
  try {
    if (value instanceof Date) return value;
    if (Array.isArray(value))
      return value.map((item) => redactResultPaths(item, key, seen));
    if (value instanceof Map) {
      return new Map(
        [...value.entries()].map(([entryKey, entryValue]) => [
          redactResultPaths(entryKey, undefined, seen),
          redactResultPaths(entryValue, String(entryKey), seen),
        ])
      );
    }
    if (value instanceof Set)
      return new Set(
        [...value].map((item) => redactResultPaths(item, key, seen))
      );
    const out: Record<string, unknown> = {};
    for (const [entryKey, entryValue] of Object.entries(value))
      out[entryKey] = redactResultPaths(entryValue, entryKey, seen);
    return out;
  } finally {
    seen.delete(value);
  }
}

function sortJson(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === "bigint") return `${value}n`;
  if (typeof value !== "object" || value === null) return value;
  if (seen.has(value))
    throw new TypeError("CLI output contains a cyclic value.");
  seen.add(value);
  try {
    if (value instanceof Date)
      return Number.isNaN(value.getTime())
        ? null
        : Date.prototype.toISOString.call(value);
    if (Array.isArray(value)) return value.map((item) => sortJson(item, seen));
    if (value instanceof Map) {
      return [...value.entries()]
        .map(
          ([key, item]) => [sortJson(key, seen), sortJson(item, seen)] as const
        )
        .sort((left, right) =>
          compareText(
            `${jsonSortKey(left[0])}\u0000${jsonSortKey(left[1])}`,
            `${jsonSortKey(right[0])}\u0000${jsonSortKey(right[1])}`
          )
        );
    }
    if (value instanceof Set) {
      return [...value]
        .map((item) => sortJson(item, seen))
        .sort((left, right) =>
          compareText(jsonSortKey(left), jsonSortKey(right))
        );
    }
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort())
      out[key] = sortJson((value as Record<string, unknown>)[key], seen);
    return out;
  } finally {
    seen.delete(value);
  }
}

function compareDiagnostics(left: Diagnostic, right: Diagnostic): number {
  const leftKey = [
    left.severity,
    left.fixture,
    left.source,
    left.path,
    left.fieldPath,
    left.code,
    left.message,
    left.hint,
  ]
    .map((part) => part ?? "")
    .join("\u0000");
  const rightKey = [
    right.severity,
    right.fixture,
    right.source,
    right.path,
    right.fieldPath,
    right.code,
    right.message,
    right.hint,
  ]
    .map((part) => part ?? "")
    .join("\u0000");
  return compareText(leftKey, rightKey);
}

function redactAbsolutePaths(value: string): string {
  return value
    .replace(/(^|[\s("'`])file:\/\/\/[^\s"'`)]*/gi, "$1<redacted>")
    .replace(/(^|[\s("'`])\/(?!\/)[^\s"'`)]*/g, "$1<redacted>")
    .replace(/(^|[\s("'`])\/\/[^\s"'`)]*/g, "$1<redacted>")
    .replace(/(^|[\s("'`])[A-Za-z]:[\\/][^\s"'`)]*/g, "$1<redacted>");
}

function jsonSortKey(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
