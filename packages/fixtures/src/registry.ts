import { compareCodePoints } from "./order.js";
import { FixtureError } from "./errors.js";
import type { FixtureRegistryLike, FixtureTypeDefinition } from "./types.js";

export class FixtureRegistry implements FixtureRegistryLike {
  private readonly defs = new Map<string, FixtureTypeDefinition>();

  register(def: FixtureTypeDefinition): void {
    // A type with no contract at all would load anything, silently, in every
    // language. `jsonSchema: true` is the explicit way to say "any value".
    if (def.jsonSchema === undefined && !def.schema) {
      throw new FixtureError({
        severity: "error",
        code: "missing-schema",
        message: `Fixture type "${def.type}" must declare "jsonSchema" or "schema".`,
        hint: 'Use `jsonSchema: true` for a type whose documents are unconstrained.',
      });
    }
    if (this.defs.has(def.type)) {
      throw new FixtureError({
        severity: "error",
        code: "duplicate-type",
        message: `Fixture type "${def.type}" is already registered.`,
      });
    }
    this.defs.set(def.type, def);
  }

  get(type: string): FixtureTypeDefinition | undefined {
    return this.defs.get(type);
  }

  has(type: string): boolean {
    return this.defs.has(type);
  }

  types(): string[] {
    return [...this.defs.keys()].sort(compareCodePoints);
  }
}

export function createFixtureRegistry(): FixtureRegistry {
  return new FixtureRegistry();
}
