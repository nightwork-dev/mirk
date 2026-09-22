export type SurrealValueErrorCode = "unserializable-value";

export class SurrealValueError extends TypeError {
  declare readonly name: "SurrealValueError";
  constructor(readonly code: SurrealValueErrorCode, message: string) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
Object.defineProperty(SurrealValueError.prototype, "name", {
  value: "SurrealValueError",
  writable: true,
  configurable: true,
  enumerable: false,
});

/**
 * Deep-copy a JSON-safe value through `JSON.stringify`/`JSON.parse`.
 *
 * When `value` has no JSON form (`undefined`, a function, a symbol) and
 * `unserializableMessage` is given, throws a `SurrealValueError` (a `TypeError`)
 * with that message.
 * Without it, `JSON.parse` receives `undefined` and throws its own
 * `SyntaxError`.
 */
export function cloneJson<T>(value: T, unserializableMessage?: string): T {
  const serialized = JSON.stringify(value);
  if (serialized === undefined && unserializableMessage !== undefined) {
    throw new SurrealValueError("unserializable-value", unserializableMessage);
  }
  return JSON.parse(serialized as string) as T;
}
