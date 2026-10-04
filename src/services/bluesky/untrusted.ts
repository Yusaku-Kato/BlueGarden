/** Helpers for narrowing untrusted (`unknown`) external data without type assertions. */

export function isRecord(value: unknown): value is object {
  return typeof value === "object" && value !== null;
}

/** Reads `key` from an object-like value (including getters on prototypes). Anything else yields undefined. */
export function readProp(value: unknown, key: string): unknown {
  if (!isRecord(value) || !(key in value)) return undefined;
  const result: unknown = Reflect.get(value, key);
  return result;
}

export function readString(value: unknown, key: string): string | undefined {
  const result = readProp(value, key);
  return typeof result === "string" ? result : undefined;
}

export function readNumber(value: unknown, key: string): number | undefined {
  const result = readProp(value, key);
  return typeof result === "number" ? result : undefined;
}
