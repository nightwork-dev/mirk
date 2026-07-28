export function firstStatement<T>(result: unknown): T {
  if (!Array.isArray(result)) return result as T;
  return result[0] as T;
}
