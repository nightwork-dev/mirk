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
  SourceRange,
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
  StandardSchemaV1Issue,
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

/** Skip sets hold whole source ids and, for a file that failed to read or
 *  parse, that one file. The NUL keeps a file key from ever equalling an id. */
function fileSkipKey(sourceId: string, relativePath: string): string {
  return `${sourceId}\u0000${relativePath}`;
}

type PositionFor = (path: ReadonlyArray<PropertyKey>) => SourceRange | undefined;

const BUILTIN_PARSERS: Record<string, ParserEntry> = {
  ".json": { kind: "plain", parse: (content: string) => JSON.parse(content) as unknown },
};

export function createFixtureLoader(opts: FixtureLoaderOptions): FixtureLoader {
  const layeredSources = normalizeLayers(opts.sources);
  assertDistinctSourceIds(layeredSources);
  const parsers = normalizeParsers(opts.parsers);
  const rawCache = new Map<string, LoadedFixture>();
  const materialCache = new Map<string, unknown>();
  const parsedDocumentCache = new Map<string, unknown>();
  const positionIndex = new Map<string, PositionFor>();
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
        if (skipSources.has(fileSkipKey(layered.source.id, entry.relativePath))) continue;
        out.push({ layered, entry, ext: match.ext, fileId: match.id });
      }
    }

    return out;
  }

  async function readAndParse(candidate: FileCandidate): Promise<unknown> {
    // The matched EXTENSION is part of the key. Two types can match the same
    // file through different extension lists, and so through different parsers;
    // without the extension the second type would read the first one's parse.
    const cacheKey = [
      candidate.layered.source.id,
      candidate.entry.locator,
      candidate.entry.relativePath,
      candidate.ext,
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
      let value = result;
      if (isPositionedResult(result)) {
        value = result.value;
        positionIndex.set(
          fileSkipKey(candidate.layered.source.id, candidate.entry.relativePath),
          result.positionFor.bind(result),
        );
      }
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
        if (match && !skipSources.has(fileSkipKey(layered.source.id, entry.relativePath))) {
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

  /** A position is decoration. A missing index, a parser that throws or one
   *  that returns nonsense yields no range and changes nothing else. */
  function rangeAt(sourceId: string, sourcePath: string, fieldPath: ReadonlyArray<PropertyKey>): SourceRange | undefined {
    const hash = sourcePath.indexOf("#");
    const file = hash < 0 ? sourcePath : sourcePath.slice(0, hash);
    const positionFor = positionIndex.get(fileSkipKey(sourceId, file));
    if (!positionFor) return undefined;
    try {
      const range = positionFor(hash < 0 ? fieldPath : [sourcePath.slice(hash + 1), ...fieldPath]);
      return range && typeof range === "object" && typeof range.start?.line === "number" ? range : undefined;
    } catch {
      return undefined;
    }
  }

  function issueRanges(
    sourceId: string,
    sourcePath: string,
    issues: ReadonlyArray<StandardSchemaV1Issue>,
  ): Array<SourceRange | undefined> {
    return issues.map((issue) =>
      issue.path
        ? rangeAt(sourceId, sourcePath, issue.path.map((part) => (typeof part === "object" && part !== null ? part.key : part)))
        : undefined
    );
  }

  function rangeInLayers(
    layers: ReadonlyArray<FixtureProvenanceLayer>,
    fieldPath: ReadonlyArray<PropertyKey>,
  ): SourceRange | undefined {
    for (let i = layers.length - 1; i >= 0; i--) {
      const layer = layers[i];
      if (!layer || layer.kind === "shadowed") continue;
      const range = rangeAt(layer.sourceId, layer.path, fieldPath);
      if (range) return range;
    }
    return undefined;
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
        throw new FixtureValidationError(ref, sourceId, relativePath, issues, issueRanges(sourceId, relativePath, issues));
      }
    }
    if (!def.schema) return parsed;
    const result = await def.schema["~standard"].validate(parsed);
    if ("issues" in result && result.issues) {
      throw new FixtureValidationError(
        ref,
        sourceId,
        relativePath,
        result.issues,
        issueRanges(sourceId, relativePath, result.issues),
      );
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
        diagnostics.push(...await validateExtractedReferences(loaded.ref, loaded.value, opts.registry.get(loaded.type), skippedSources, loaded.provenance.layers));
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
      positionIndex.clear();
      return;
    }
    rawCache.delete(ref);
    materialCache.clear();
    parsedDocumentCache.clear();
    positionIndex.clear();
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
      for (;;) {
        try {
          const candidates = await parsedCandidates(typeName, undefined, skippedSources);
          for (const candidate of candidates) refs.add(`${typeName}:${candidate.id}`);
          break;
        } catch (error) {
          diagnostics.push(...diagnosticsFromError(typeName, error));
          if (!skipFailure(error, skippedSources)) break;
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

  /** Skip what failed, no more: the one file when the error names a file,
   *  else the whole source. False when there is nothing new to skip, which
   *  ends the retry. */
  function skipFailure(error: unknown, skipped: Set<string>): boolean {
    if (!(error instanceof FixtureError)) return false;
    const { source, path } = error.diagnostic;
    if (!source) return false;
    const key = path ? fileSkipKey(source, path.split("#")[0] ?? path) : source;
    if (skipped.has(key)) return false;
    skipped.add(key);
    return true;
  }

  function failedFileFor(ref: string, skipped: ReadonlySet<string>): { sourceId: string; path: string } | undefined {
    const { type, id } = parseRef(ref);
    const def = opts.registry.get(type);
    if (!def) return undefined;
    for (const key of [...skipped].sort(compareCodePoints)) {
      const split = key.indexOf("\u0000");
      if (split < 0) continue;
      const path = key.slice(split + 1);
      if (matchEntry(def, { relativePath: path, locator: path }, def.document ? undefined : id)) {
        return { sourceId: key.slice(0, split), path };
      }
    }
    return undefined;
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
    layers: ReadonlyArray<FixtureProvenanceLayer>,
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
          ...rangeProp(rangeInLayers(layers, extracted.fieldPath)),
        });
        continue;
      }

      try {
        await loadRawInternal(extracted.ref, skipSources);
      } catch (error) {
        if (error instanceof FixtureError && error.diagnostic.code === "not-found") {
          const failed = failedFileFor(extracted.ref, skipSources);
          out.push(failed
            ? {
              severity: "warning",
              code: "unresolved-reference",
              message: `Referenced fixture "${extracted.ref}" could not be checked: it may be defined in "${failed.path}" (source "${failed.sourceId}"), which failed to load.`,
              fixture,
              fieldPath: pathString(extracted.fieldPath),
              ...rangeProp(rangeInLayers(layers, extracted.fieldPath)),
            }
            : {
              severity: "error",
              code: "missing-reference",
              message: `Missing referenced fixture "${extracted.ref}".`,
              fixture,
              fieldPath: pathString(extracted.fieldPath),
              ...rangeProp(rangeInLayers(layers, extracted.fieldPath)),
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

/** Source ids must be distinct across the layer stack.
 *
 *  The parsed-document cache, the skipped-source set and every diagnostic key
 *  a source by its id, so two layers sharing one id collapse into each other:
 *  the lower layer's document is served for the higher one and a source
 *  skipped for a read error takes its namesake down with it. That is a data
 *  bug with no local symptom, so it is refused where it is introduced. */
function assertDistinctSourceIds(layers: ReadonlyArray<LayeredSource>): void {
  const seen = new Set<string>();
  for (const layered of layers) {
    const id = layered.source.id;
    if (seen.has(id)) {
      throw new FixtureError({
        severity: "error",
        code: "duplicate-source",
        message: `Duplicate fixture source id "${id}".`,
        source: id,
        hint: "Give every fixture source a distinct id; layer order is set by priority, not by id.",
      });
    }
    seen.add(id);
  }
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

function rangeProp(range: SourceRange | undefined): { range?: SourceRange } {
  return range ? { range } : {};
}

function pathString(path: ReadonlyArray<PropertyKey>): string {
  return path.map(String).join(".");
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
