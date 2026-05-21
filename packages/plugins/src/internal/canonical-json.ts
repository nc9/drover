/**
 * Canonical JSON serializer for hash inputs. Recursively sorts object keys,
 * preserves array order — so semantically-identical args produce identical
 * hashes regardless of key insertion order. Dedup-cache correctness depends
 * on this.
 *
 * Rejects circular references; treats `undefined` like `JSON.stringify`
 * (dropped from objects, `null` in arrays).
 */
export function canonicalJsonStringify(value: unknown): string {
  return canonicalize(value);
}

function canonicalize(value: unknown, seen: WeakSet<object> = new WeakSet()): string {
  if (value === null) return "null";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "bigint") return JSON.stringify(value.toString());
  if (typeof value === "undefined" || typeof value === "function" || typeof value === "symbol") {
    return "null";
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new Error("canonicalJsonStringify: circular reference");
    seen.add(value);
    const out = `[${value.map((v) => canonicalize(v, seen)).join(",")}]`;
    seen.delete(value);
    return out;
  }
  if (typeof value === "object") {
    if (seen.has(value as object)) throw new Error("canonicalJsonStringify: circular reference");
    seen.add(value as object);
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).toSorted();
    const parts: string[] = [];
    for (const k of keys) {
      const v = obj[k];
      if (v === undefined) continue;
      parts.push(`${JSON.stringify(k)}:${canonicalize(v, seen)}`);
    }
    seen.delete(value as object);
    return `{${parts.join(",")}}`;
  }
  return "null";
}
