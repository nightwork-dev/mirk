import { compareCodePoints } from "./order.js";
import { FixtureError, FixtureValidationError, diagnosticsFromError } from "./errors.js";
import { isPatchDocument, mergeWithStrategy, normalizeLayers, patchBody, provenanceCtx } from "./layering.js";
import { buildReferenceGraph } from "./reference-graph.js";
import { isCanonicalRef, isExplicitRef, parseRef } from "./refs.js";
import type {
  Diagnostic,
  ExtractedReference,
  FixtureLoader,
  FixtureLoaderOptions,
  FixtureProvenanceLayer,
  FixtureSourceEntry,
  FixtureTypeDefinition,
  JsonSchemaDocument,
  JsonSchemaValidator,
  LayeredSource,
  LoadedFixture,
  Parser,
  ParserEntry,
  PositionedParseResult,
  RefOrInline,
  ReferenceGraph,
  ReferenceMode,
  ValidationContext,
  ValidationReport,
} from "./types.js";

interface FileCandidate {
  layered: LayeredSource;
  entry: FixtureSourceEntry;
  ext: string;
  fileId: string;
}

interface ParsedLayer extends FileCandidate {
  id: string;
  parsed: unknown;
  sourcePath: string;
}

const BUILTIN_PARSERS: Record<string, ParserEntry> = {
  ".json": { kind: "plain", parse: (content: string) => JSON.parse(content) as unknown },
};

export function createFixtureLoader(opts: FixtureLoaderOptions): FixtureLoader {
  const layeredSources = normalizeLayers(opts.sources);
  const parsers = normalizeParsers(opts.parsers);
  const rawCache = new Map<string, LoadedFixture>();
  const materialCache = new Map<string, unknown>();
  const parsedDocumentCache = new Map<string, unknown>();
  // One compiled validator per type definition. The factory is the caller's,
  // so compilation cost is theirs to pay once, not once per fixture.
  const jsonSchemaValidators = new Map<FixtureTypeDefinition, JsonSchemaValidator>();

  function defOrThrow(type: string, refForError: string): FixtureTypeDefinition {
    const def = opts.registry.get(type);
    if (!def) {
      throw new FixtureError({
        severity: "error",
        code: "unknown-type",
        message: `Unknown fixture type "${type}".`,
        fixture: refForError,
        hint: `Register fixture type "${type}" before loading it.`,
      });
    }
    return def;
  }

  function extensionsFor(def: FixtureTypeDefinition): string[] {
    if (def.extensions && def.extensions.length > 0) return def.extensions;
    return Object.keys(parsers);
  }

  function dirPrefix(def: FixtureTypeDefinition): string {
    if (def.directory === "" || def.directory === "/") return "";
    return def.directory.endsWith("/") ? def.directory : `${def.directory}/`;
  }

  function matchEntry(
    def: FixtureTypeDefinition,
    entry: FixtureSourceEntry,
    targetId?: string,
  ): { id: string; ext: string } | undefined {
    const prefix = dirPrefix(def);
    if (prefix && !entry.relativePath.startsWith(prefix)) return undefined;

    const tail = prefix ? entry.relativePath.slice(prefix.length) : entry.relativePath;
    if (tail.includes("/")) return undefined;

    const ext = extensionsFor(def).find((candidate) => tail.endsWith(candidate));
    if (!ext) return undefined;

    const id = tail.slice(0, tail.length - ext.length);
    if (!id) return undefined;
    if (targetId !== undefined && id !== targetId) return undefined;
    return { id, ext };
  }

  function noParserDiagnosticForEntry(
    def: FixtureTypeDefinition,
    entry: FixtureSourceEntry,
    sourceId: string,
  ): Diagnostic | undefined {
    const prefix = dirPrefix(def);
    if (prefix && !entry.relativePath.startsWith(prefix)) return undefined;

    const tail = prefix ? entry.relativePath.slice(prefix.length) : entry.relativePath;
    if (!tail || tail.includes("/")) return undefined;

    const dot = tail.lastIndexOf(".");
    if (dot <= 0) return undefined;
    const ext = tail.slice(dot);
    if (parsers[ext]) return undefined;

    return {
      severity: "error",
      code: "no-parser",
      message: `No parser registered for "${ext}".`,
      source: sourceId,
      path: entry.relativePath,
      hint: `Pass a parser for "${ext}" to createFixtureLoader().`,
    };
  }

  async function findCandidates(type: string, id: string, skipSources = new Set<string>()): Promise<FileCandidate[]> {
    const def = defOrThrow(type, `${type}:${id}`);
    const out: FileCandidate[] = [];

    for (const layered of layeredSources) {
      if (skipSources.has(layered.source.id)) continue;
      let entries: readonly FixtureSourceEntry[];
      try {
        entries = await layered.source.list();
      } catch (error) {
        throw new FixtureError({
          severity: "error",
          code: "source-list-failed",
          message: `Source "${layered.source.id}" failed to list entries: ${messageOf(error)}`,
          source: layered.source.id,
        });
      }

      for (const entry of entries) {
        const match = matchEntry(def, entry, def.document ? undefined : id);
        if (!match) continue;
        out.push({ layered, entry, ext: match.ext, fileId: match.id });
      }
    }

    return out;
  }

  async function readAndParse(candidate: FileCandidate): Promise<unknown> {
    const cacheKey = [
      candidate.layered.source.id,
      candidate.entry.locator,
      candidate.entry.relativePath,
    ].join("\u0000");
    if (parsedDocumentCache.has(cacheKey)) {
      return parsedDocumentCache.get(cacheKey);
    }
    const parser = parsers[candidate.ext];
    if (!parser) {
      throw new FixtureError({
        severity: "error",
        code: "no-parser",
        message: `No parser registered for "${candidate.ext}".`,
        source: candidate.layered.source.id,
        path: candidate.entry.relativePath,
        hint: `Pass a parser for "${candidate.ext}" to createFixtureLoader().`,
      });
    }

    let content: string;
    try {
      content = await candidate.layered.source.read(candidate.entry);
    } catch (error) {
      throw new FixtureError({
        severity: "error",
        code: "source-read-failed",
        message: `Source "${candidate.layered.source.id}" failed to read "${candidate.entry.relativePath}": ${messageOf(error)}`,
        source: candidate.layered.source.id,
        path: candidate.entry.relativePath,
      });
    }

    try {
      const result = await parseWith(parser, content);
      const value = isPositionedResult(result) ? result.value : result;
      parsedDocumentCache.set(cacheKey, value);
      return value;
    } catch (error) {
      throw new FixtureError({
        severity: "error",
        code: "parse-failed",
        message: `Parse error: ${messageOf(error)}`,
        source: candidate.layered.source.id,
        path: candidate.entry.relativePath,
      });
    }
  }

  async function expandMapDocument(
    def: FixtureTypeDefinition,
    candidate: FileCandidate,
  ): Promise<ParsedLayer[]> {
    const parsed = await readAndParse(candidate);
    if (!def.document) {
      return [{
        ...candidate,
        id: candidate.fileId,
        parsed,
        sourcePath: candidate.entry.relativePath,
      }];
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      throw new FixtureError({
        severity: "error",
        code: "invalid-map-document",
        message: "Fixture map documents must parse to an object keyed by fixture id.",
        source: candidate.layered.source.id,
        path: candidate.entry.relativePath,
      });
    }

    const layers: ParsedLayer[] = [];
    for (const [id, rawValue] of Object.entries(parsed)) {
      let value = rawValue;
      const idField = def.document.idField;
      if (idField) {
        if (typeof value !== "object" || value === null || Array.isArray(value)) {
          throw new FixtureError({
            severity: "error",
            code: "invalid-map-fixture",
            message: `Fixture "${def.type}:${id}" must be an object to inject "${idField}".`,
            fixture: `${def.type}:${id}`,
            source: candidate.layered.source.id,
            path: `${candidate.entry.relativePath}#${id}`,
          });
        }
        const record = value as Record<string, unknown>;
        const explicitId = record[idField];
        if (explicitId !== undefined && explicitId !== id) {
          throw new FixtureError({
            severity: "error",
            code: "map-id-mismatch",
            message: `Map key "${id}" does not match explicit ${idField} "${String(explicitId)}".`,
            fixture: `${def.type}:${id}`,
            source: candidate.layered.source.id,
            path: `${candidate.entry.relativePath}#${id}`,
          });
        }
        if (!isPatchDocument(value) && explicitId === undefined) {
          value = { [idField]: id, ...record };
        }
      }
      layers.push({
        ...candidate,
        id,
        parsed: value,
        sourcePath: `${candidate.entry.relativePath}#${id}`,
      });
    }
    return layers;
  }

  async function parsedCandidates(
    type: string,
    targetId: string | undefined,
    skipSources = new Set<string>(),
  ): Promise<ParsedLayer[]> {
    const def = defOrThrow(type, targetId ? `${type}:${targetId}` : type);
    const candidates = targetId
      ? await findCandidates(type, targetId, skipSources)
      : await findAllFileCandidates(def, skipSources);
    const parsed: ParsedLayer[] = [];
    const seen = new Set<string>();
    for (const candidate of candidates) {
      const layers = await expandMapDocument(def, candidate);
      for (const layer of layers) {
        if (targetId !== undefined && layer.id !== targetId) continue;
        const key = [
          layer.layered.source.id,
          layer.layered.layer,
          layer.layered.priority,
          layer.id,
        ].join("\u0000");
        if (seen.has(key)) {
          throw new FixtureError({
            severity: "error",
            code: "duplicate-map-fixture",
            message: `Fixture "${type}:${layer.id}" appears more than once in the same source layer.`,
            fixture: `${type}:${layer.id}`,
            source: layer.layered.source.id,
            path: layer.sourcePath,
          });
        }
        seen.add(key);
        parsed.push(layer);
      }
    }
    return parsed;
  }

  async function findAllFileCandidates(
    def: FixtureTypeDefinition,
    skipSources = new Set<string>(),
  ): Promise<FileCandidate[]> {
    const out: FileCandidate[] = [];
    for (const layered of layeredSources) {
      if (skipSources.has(layered.source.id)) continue;
      let entries: readonly FixtureSourceEntry[];
      try {
        entries = await layered.source.list();
      } catch (error) {
        throw new FixtureError({
          severity: "error",
          code: "source-list-failed",
          message: `Source "${layered.source.id}" failed to list entries: ${messageOf(error)}`,
          source: layered.source.id,
        });
      }
      for (const entry of entries) {
        const match = matchEntry(def, entry);
        if (match) {
          out.push({
            layered,
            entry,
            ext: match.ext,
            fileId: match.id,
          });
        }
      }
    }
    return out;
  }

  function jsonSchemaValidatorFor(def: FixtureTypeDefinition, document: JsonSchemaDocument): JsonSchemaValidator {
    const cached = jsonSchemaValidators.get(def);
    if (cached) return cached;
    if (!opts.jsonSchemaValidator) {
      // Loud, not silent. A missing engine must never read as "this fixture
      // has no shape contract".
      throw new FixtureError({
        severity: "error",
        code: "no-json-schema-validator",
        message: `Fixture type "${def.type}" declares "jsonSchema" but no JSON Schema validator was supplied.`,
        hint: "Pass jsonSchemaValidator to createFixtureLoader().",
      });
    }
    const validator = opts.jsonSchemaValidator(document);
    jsonSchemaValidators.set(def, validator);
    return validator;
  }

  /** The whole validation surface, in order: the cross-language `jsonSchema`
   *  first, then the optional Standard Schema, whose OUTPUT becomes the value.
   *  Both failure modes are one error type and one diagnostic code, so callers,
   *  the CLI envelope and the exit-code classification are unchanged. */
  async function validateAgainstSchema(
    ref: string,
    sourceId: string,
    relativePath: string,
    parsed: unknown,
    def: FixtureTypeDefinition,
  ): Promise<unknown> {
    if (def.jsonSchema !== undefined) {
      const issues = jsonSchemaValidatorFor(def, def.jsonSchema)(parsed);
      if (issues.length > 0) {
        throw new FixtureValidationError(ref, sourceId, relativePath, issues);
      }
    }
    if (!def.schema) return parsed;
    const result = await def.schema["~standard"].validate(parsed);
    if ("issues" in result && result.issues) {
      throw new FixtureValidationError(ref, sourceId, relativePath, result.issues);
    }
    return result.value;
  }

  async function loadRaw<T = unknown>(ref: string): Promise<LoadedFixture<T>> {
    return loadRawInternal<T>(ref, new Set());
  }

  async function loadRawInternal<T = unknown>(ref: string, skipSources: ReadonlySet<string>): Promise<LoadedFixture<T>> {
    const canUseCache = skipSources.size === 0;
    const cached = canUseCache ? rawCache.get(ref) : undefined;
    if (cached) return cached as LoadedFixture<T>;

    const { type, id } = parseRef(ref);
    const def = defOrThrow(type, ref);
    const parsedLayers = await parsedCandidates(type, id, new Set(skipSources));

    if (parsedLayers.length === 0) {
      throw new FixtureError({
        severity: "error",
        code: "not-found",
        message: `Fixture "${ref}" not found in any registered source.`,
        fixture: ref,
        hint: `Looked under "${dirPrefix(def)}${id}" with extensions ${extensionsFor(def).join(", ")}.`,
      });
    }

    for (const layer of parsedLayers) {
      if (isPatchDocument(layer.parsed) && layer.parsed.$patch !== ref) {
        throw new FixtureError({
          severity: "error",
          code: "patch-ref-mismatch",
          message: `Patch declares "$patch: ${layer.parsed.$patch}" but is being applied to "${ref}".`,
          fixture: ref,
          source: layer.layered.source.id,
          path: layer.sourcePath,
        });
      }
    }

    let baseIdx = -1;
    for (let i = parsedLayers.length - 1; i >= 0; i--) {
      if (!isPatchDocument(parsedLayers[i]?.parsed)) {
        baseIdx = i;
        break;
      }
    }

    if (baseIdx < 0) {
      throw new FixtureError({
        severity: "error",
        code: "patch-without-base",
        message: `Fixture "${ref}" has patches but no base document.`,
        fixture: ref,
        hint: "At least one layer must contain a full fixture document without $patch.",
      });
    }

    const baseLayer = parsedLayers[baseIdx];
    if (!baseLayer) throw new Error("unreachable: base layer missing");

    let current = await validateAgainstSchema(
      ref,
      baseLayer.layered.source.id,
      baseLayer.sourcePath,
      baseLayer.parsed,
      def,
    );

    const provenance: FixtureProvenanceLayer[] = [];

    for (let i = 0; i < baseIdx; i++) {
      const layer = parsedLayers[i];
      if (!layer) continue;
      provenance.push({
        sourceId: layer.layered.source.id,
        layer: layer.layered.layer,
        priority: layer.layered.priority,
        path: layer.sourcePath,
        kind: isPatchDocument(layer.parsed) ? "shadowed" : "replace",
      });
    }

    provenance.push({
      sourceId: baseLayer.layered.source.id,
      layer: baseLayer.layered.layer,
      priority: baseLayer.layered.priority,
      path: baseLayer.sourcePath,
      kind: "base",
    });

    for (let i = baseIdx + 1; i < parsedLayers.length; i++) {
      const layer = parsedLayers[i];
      if (!layer) continue;
      if (!isPatchDocument(layer.parsed)) continue;

      if (layer.layered.priority <= baseLayer.layered.priority) {
        provenance.push({
          sourceId: layer.layered.source.id,
          layer: layer.layered.layer,
          priority: layer.layered.priority,
          path: layer.sourcePath,
          kind: "shadowed",
        });
        continue;
      }

      const body = patchBody(layer.parsed);
      const merged = mergeWithStrategy(def.mergeStrategy, current, body, {
        fixture: ref,
        layers: provenanceCtx(provenance),
      });
      current = await validateAgainstSchema(ref, layer.layered.source.id, layer.sourcePath, merged, def);
      provenance.push({
        sourceId: layer.layered.source.id,
        layer: layer.layered.layer,
        priority: layer.layered.priority,
        path: layer.sourcePath,
        kind: "patch",
      });
    }

    const loaded: LoadedFixture<T> = {
      ref,
      type,
      id,
      value: current as T,
      provenance: { finalRef: ref, layers: provenance },
    };
    if (canUseCache) rawCache.set(ref, loaded);
    return loaded;
  }

  async function load<T = unknown>(ref: string): Promise<T> {
    return (await loadRaw<T>(ref)).value;
  }

  async function list(type?: string): Promise<string[]> {
    const refs = new Set<string>();
    const types = type ? (opts.registry.has(type) ? [type] : []) : opts.registry.types();

    for (const typeName of types) {
      const def = opts.registry.get(typeName);
      if (!def) continue;
      const candidates = await parsedCandidates(typeName, undefined);
      for (const candidate of candidates) {
        refs.add(`${typeName}:${candidate.id}`);
      }
    }

    return [...refs].sort(compareCodePoints);
  }

  async function resolveRef<T>(value: RefOrInline<T>, expectedType?: string): Promise<T> {
    if (isExplicitRef(value)) {
      const ref = value.$ref;
      const { type } = parseRef(ref);
      if (expectedType && type !== expectedType) {
        throw new FixtureError({
          severity: "error",
          code: "type-mismatch",
          message: `Expected ref of type "${expectedType}" but got "${type}".`,
          fixture: ref,
        });
      }
      return load<T>(ref);
    }

    if (typeof value === "string" && isCanonicalRef(value) && bareRefsEnabledFor(value, expectedType)) {
      const { type } = parseRef(value);
      if (expectedType && type !== expectedType) {
        throw new FixtureError({
          severity: "error",
          code: "type-mismatch",
          message: `Expected ref of type "${expectedType}" but got "${type}".`,
          fixture: value,
        });
      }
      return load<T>(value);
    }

    if (expectedType) {
      const def = defOrThrow(expectedType, `<inline ${expectedType}>`);
      return await validateAgainstSchema(
        `<inline ${expectedType}>`,
        "<inline>",
        "<inline>",
        value,
        def,
      ) as T;
    }

    return value as T;
  }

  async function validate(ref?: string): Promise<ValidationReport> {
    const diagnostics: Diagnostic[] = [];
    const skippedSources = new Set<string>();
    const refs = ref ? [ref] : await discoverRefsForValidation(diagnostics, skippedSources);

    for (const currentRef of refs) {
      try {
        const loaded = await loadRawInternal(currentRef, skippedSources);
        diagnostics.push(...await validateExtractedReferences(loaded.ref, loaded.value, opts.registry.get(loaded.type), skippedSources));
        const def = opts.registry.get(loaded.type);
        if (def?.validateReferences) {
          const issues = await def.validateReferences(loaded.value, makeValidationContext(loaded.ref, skippedSources));
          diagnostics.push(...issues.map((issue) => ({ fixture: loaded.ref, ...issue })));
        }
      } catch (error) {
        diagnostics.push(...diagnosticsFromError(currentRef, error));
      }
    }

    return { ok: diagnostics.every((diagnostic) => diagnostic.severity !== "error"), diagnostics };
  }

  async function referenceGraph(): Promise<ReferenceGraph> {
    const refs = await list();
    const entries = [];

    for (const ref of refs) {
      try {
        const loaded = await loadRaw(ref);
        const def = opts.registry.get(loaded.type);
        entries.push({
          ref,
          value: loaded.value,
          resolved: true,
          refs: extractReferences(loaded.value, def),
        });
      } catch {
        entries.push({ ref, value: undefined, resolved: false, refs: [] });
      }
    }

    const diagnostics: Diagnostic[] = [];
    for (const entry of entries) {
      if (!entry.resolved) continue;
      for (const extracted of entry.refs) {
        try {
          parseRef(extracted.ref);
        } catch {
          diagnostics.push({
            severity: "error",
            code: "invalid-ref",
            message: `Invalid fixture ref "${extracted.ref}".`,
            fixture: entry.ref,
            fieldPath: pathString(extracted.fieldPath),
          });
        }
      }
    }

    return buildReferenceGraph(entries, diagnostics);
  }

  async function materialize<M = unknown>(ref: string): Promise<M> {
    return materializeInternal<M>(ref, []);
  }

  async function materializeInternal<M>(ref: string, stack: string[]): Promise<M> {
    if (materialCache.has(ref)) return materialCache.get(ref) as M;
    if (stack.includes(ref)) {
      const cycle = [...stack.slice(stack.indexOf(ref)), ref];
      throw new FixtureError({
        severity: "error",
        code: "materialization-cycle",
        message: `Materialization cycle detected: ${cycle.join(" -> ")}.`,
        fixture: ref,
      });
    }

    const nextStack = [...stack, ref];
    const loaded = await loadRaw(ref);
    const def = opts.registry.get(loaded.type);
    const value = def?.materialize
      ? await def.materialize(loaded.value, {
        ref,
        loadRaw: async <U = unknown>(childRef: string) => load<U>(childRef),
        materialize: async <U = unknown>(childRef: string) => materializeInternal<U>(childRef, nextStack),
      })
      : loaded.value;
    materialCache.set(ref, value);
    return value as M;
  }

  function invalidate(ref?: string): void {
    if (!ref) {
      rawCache.clear();
      materialCache.clear();
      parsedDocumentCache.clear();
      return;
    }
    rawCache.delete(ref);
    materialCache.clear();
    parsedDocumentCache.clear();
  }

  function bareRefsEnabledFor(ref: string, expectedType: string | undefined): boolean {
    if (opts.referenceMode === "explicit-and-bare") return true;
    const type = expectedType ?? parseRef(ref).type;
    return opts.registry.get(type)?.referenceMode === "explicit-and-bare";
  }

  async function discoverRefsForValidation(diagnostics: Diagnostic[], skippedSources: Set<string>): Promise<string[]> {
    const refs = new Set<string>();
    const seenNoParserDiagnostics = new Set<string>();
    for (const typeName of opts.registry.types()) {
      const def = opts.registry.get(typeName);
      if (!def) continue;
      try {
        const candidates = await parsedCandidates(typeName, undefined, skippedSources);
        for (const candidate of candidates) refs.add(`${typeName}:${candidate.id}`);
      } catch (error) {
        if (error instanceof FixtureError && error.diagnostic.source) {
          skippedSources.add(error.diagnostic.source);
        }
        diagnostics.push(...diagnosticsFromError(typeName, error));
        try {
          const remaining = await parsedCandidates(typeName, undefined, skippedSources);
          for (const candidate of remaining) refs.add(`${typeName}:${candidate.id}`);
        } catch (remainingError) {
          diagnostics.push(...diagnosticsFromError(typeName, remainingError));
        }
      }
      for (const layered of layeredSources) {
        if (skippedSources.has(layered.source.id)) continue;
        let entries: readonly FixtureSourceEntry[];
        try {
          entries = await layered.source.list();
        } catch (error) {
          skippedSources.add(layered.source.id);
          diagnostics.push({
            severity: "error",
            code: "source-list-failed",
            message: `Source "${layered.source.id}" failed to list entries: ${messageOf(error)}`,
            source: layered.source.id,
          });
          continue;
        }
        for (const entry of entries) {
          const match = matchEntry(def, entry);
          if (match) continue;

          const noParser = noParserDiagnosticForEntry(def, entry, layered.source.id);
          if (!noParser) continue;
          const key = `${noParser.source ?? ""}\u0000${noParser.path ?? ""}\u0000${noParser.message}`;
          if (seenNoParserDiagnostics.has(key)) continue;
          seenNoParserDiagnostics.add(key);
          diagnostics.push(noParser);
        }
      }
    }
    return [...refs].sort(compareCodePoints);
  }

  function makeValidationContext(ref: string, skipSources: ReadonlySet<string>): ValidationContext {
    return {
      ref,
      has: async (otherRef) => {
        try {
          await loadRawInternal(otherRef, skipSources);
          return true;
        } catch (error) {
          if (error instanceof FixtureError && error.diagnostic.code === "not-found") return false;
          throw error;
        }
      },
      loadRaw: async <U = unknown>(otherRef: string) => (await loadRawInternal<U>(otherRef, skipSources)).value,
    };
  }

  async function validateExtractedReferences(
    fixture: string,
    value: unknown,
    def: FixtureTypeDefinition | undefined,
    skipSources: ReadonlySet<string>,
  ): Promise<Diagnostic[]> {
    const out: Diagnostic[] = [];
    for (const extracted of extractReferences(value, def)) {
      try {
        parseRef(extracted.ref);
      } catch {
        out.push({
          severity: "error",
          code: "invalid-ref",
          message: `Invalid fixture ref "${extracted.ref}".`,
          fixture,
          fieldPath: pathString(extracted.fieldPath),
        });
        continue;
      }

      try {
        await loadRawInternal(extracted.ref, skipSources);
      } catch (error) {
        if (error instanceof FixtureError && error.diagnostic.code === "not-found") {
          out.push({
            severity: "error",
            code: "missing-reference",
            message: `Missing referenced fixture "${extracted.ref}".`,
            fixture,
            fieldPath: pathString(extracted.fieldPath),
          });
        } else {
          throw error;
        }
      }
    }
    return out;
  }

  function extractReferences(value: unknown, def: FixtureTypeDefinition | undefined): ExtractedReference[] {
    const out: ExtractedReference[] = [];
    const mode = def?.referenceMode ?? opts.referenceMode ?? "explicit-only";
    walkRefs(value, [], out, mode, new WeakSet(), 0);
    if (def?.extractReferences) out.push(...def.extractReferences(value));
    return dedupeReferences(out);
  }

  return {
    load,
    loadRaw,
    materialize,
    list,
    resolveRef,
    validate,
    referenceGraph,
    invalidate,
  };
}

function normalizeParsers(
  parsers: FixtureLoaderOptions["parsers"],
): Record<string, ParserEntry> {
  const out: Record<string, ParserEntry> = { ...BUILTIN_PARSERS };
  if (!parsers) return out;

  for (const [ext, parser] of Object.entries(parsers)) {
    out[ext] = isParserEntry(parser) ? parser : { kind: "plain", parse: parser as Parser };
  }
  return out;
}

function isParserEntry(value: unknown): value is ParserEntry {
  return typeof value === "object"
    && value !== null
    && "kind" in value
    && "parse" in value;
}

async function parseWith(parser: ParserEntry, content: string): Promise<unknown | PositionedParseResult> {
  return parser.parse(content);
}

function isPositionedResult(value: unknown): value is PositionedParseResult {
  return typeof value === "object"
    && value !== null
    && "value" in value
    && typeof (value as { positionFor?: unknown }).positionFor === "function";
}

function walkRefs(
  value: unknown,
  fieldPath: PropertyKey[],
  out: ExtractedReference[],
  mode: ReferenceMode,
  seen: WeakSet<object>,
  depth: number,
): void {
  if (depth > 32 || value === null || value === undefined) return;

  if (typeof value === "string") {
    if (mode === "explicit-and-bare" && isCanonicalRef(value)) {
      out.push({ ref: value, fieldPath: [...fieldPath] });
    }
    return;
  }

  if (typeof value !== "object") return;
  if (seen.has(value)) return;
  seen.add(value);

  if (isExplicitRef(value)) {
    out.push({ ref: value.$ref, fieldPath: [...fieldPath] });
    return;
  }

  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      walkRefs(value[i], [...fieldPath, i], out, mode, seen, depth + 1);
    }
    return;
  }

  for (const [key, child] of Object.entries(value)) {
    walkRefs(child, [...fieldPath, key], out, mode, seen, depth + 1);
  }
}

function dedupeReferences(refs: ExtractedReference[]): ExtractedReference[] {
  const seen = new Set<string>();
  const out: ExtractedReference[] = [];
  for (const ref of refs) {
    const key = `${ref.ref}\u0000${pathString(ref.fieldPath)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ref);
  }
  return out;
}

function pathString(path: ReadonlyArray<PropertyKey>): string {
  return path.map(String).join(".");
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
