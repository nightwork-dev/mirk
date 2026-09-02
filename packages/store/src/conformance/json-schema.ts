// ─── JSON Schema validation for the `fixtures` target ───────────────────────
// The TypeScript half of the cross-language validation contract. `@mirk/fixtures`
// declares a type's authored shape as a JSON Schema DOCUMENT and takes the
// engine as an injected factory, so neither package depends on one. This module
// supplies that factory from Ajv 2020 for conformance generation and replay
// only: it is TOOLING, absent from the tsup build list and from package.json
// exports, exactly like ./backends.ts.
//
// What crosses languages is the SET OF INSTANCE PATHS that failed, never the
// message. Ajv and Python's `jsonschema` word every message differently and
// count errors differently, so three rules make the two engines agree:
//
//   1. `allErrors: true` — every failure, not the first.
//   2. An aggregate keyword (`anyOf`, `oneOf`, `if`, `not`) is dropped ONLY
//      when a non-aggregate failure is already reported at the same instance
//      path or a deeper one. Then the branch failures underneath say the same
//      thing in a spelling both engines share, and the aggregate would add a
//      path meaning "some combination failed". When there is no such failure —
//      `{not: {const: "bad"}}` on `"bad"`, an overlapping `oneOf` — dropping it
//      would report zero issues and turn an invalid document into a valid one,
//      so the aggregate is KEPT at its own path.
//   3. A `required` failure keeps the CONTAINING object's path and does not
//      append the missing property. Ajv puts the name in `params`; Python puts
//      it only in the message text. Appending it in one language and not the
//      other would diverge, so neither does.

import Ajv2020 from "ajv/dist/2020.js";

import type { JsonSchemaDocument, JsonSchemaValidator, StandardSchemaV1Issue } from "@mirk/fixtures";

/** Keywords whose error is an aggregate over branch failures rather than a
 *  failure of its own. */
const AGGREGATE_KEYWORDS = new Set(["anyOf", "oneOf", "if", "not"]);

/** A JSON Pointer instance path to Standard Schema path segments. Segments are
 *  strings in both languages, so `formatIssuePath` renders an array index as
 *  `items.0` on either side. */
function pointerSegments(instancePath: string): string[] {
  if (instancePath === "") return [];
  return instancePath
    .slice(1)
    .split("/")
    .map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"));
}

/** Is `candidate` the aggregate's own instance path, or a path inside it? */
function coversPath(aggregatePath: string, candidate: string): boolean {
  return candidate === aggregatePath || candidate.startsWith(`${aggregatePath}/`);
}

/** The `JsonSchemaValidatorFactory` a conformance fixtures loader is built
 *  with. `strict: false` keeps Ajv from rejecting a schema the specification
 *  allows; the corpus pins behavior for VALID schema documents. */
export function ajvValidatorFactory(document: JsonSchemaDocument): JsonSchemaValidator {
  const AjvConstructor = (Ajv2020 as unknown as { default?: typeof Ajv2020 }).default ?? Ajv2020;
  const ajv = new AjvConstructor({ allErrors: true, strict: false });
  const validate = ajv.compile(document as object | boolean);
  return (value: unknown): StandardSchemaV1Issue[] => {
    if (validate(value)) return [];
    const errors = validate.errors ?? [];
    const leafPaths = errors
      .filter((error) => !AGGREGATE_KEYWORDS.has(error.keyword))
      .map((error) => error.instancePath);
    const issues: StandardSchemaV1Issue[] = [];
    for (const error of errors) {
      if (
        AGGREGATE_KEYWORDS.has(error.keyword) &&
        leafPaths.some((path) => coversPath(error.instancePath, path))
      ) {
        continue;
      }
      issues.push({
        message: `${error.keyword}: ${error.message ?? "invalid"}`,
        path: pointerSegments(error.instancePath),
      });
    }
    return issues;
  };
}
