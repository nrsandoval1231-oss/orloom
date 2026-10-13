function ordered(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(ordered);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort().map((key) => [key, ordered(record[key])]));
  }
  return value;
}

/** Stable JSON bytes for durable digests and JSONB equality across engines. */
export function canonicalJson(value: unknown): string {
  const encoded = JSON.stringify(ordered(value));
  if (encoded === undefined) throw new Error("value is not JSON serializable");
  return encoded;
}
