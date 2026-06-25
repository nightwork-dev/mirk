import { FixtureError } from "./errors.js";
import type { FixtureRegistryLike, FixtureTypeDefinition } from "./types.js";

export class FixtureRegistry implements FixtureRegistryLike {
  private readonly defs = new Map<string, FixtureTypeDefinition>();

  register(def: FixtureTypeDefinition): void {
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
    return [...this.defs.keys()].sort();
  }
}

export function createFixtureRegistry(): FixtureRegistry {
  return new FixtureRegistry();
}
