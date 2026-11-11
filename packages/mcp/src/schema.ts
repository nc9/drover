// Server-supplied MCP tool schemas go into the model's tool list unfenced, so
// only a known subset of JSON Schema passes, every string in it is checked, and
// a schema that cannot be made safe refuses its tool instead of reaching the model.
import { createFence, escapeTags } from "@droveragent/core";

/** Longest server-supplied description (tool or schema) the model sees. */
export const MAX_MCP_DESCRIPTION_CHARS = 500;
/** Longest property name, enum / const value, `$ref`, `type` or `required` entry kept. */
export const MAX_SCHEMA_TOKEN_CHARS = 128;
/** Largest serialised input schema accepted from a server. */
export const MAX_SCHEMA_BYTES = 32 * 1024;
/** Deepest schema nesting accepted from a server. */
export const MAX_SCHEMA_DEPTH = 32;

const cleaner = createFence({ nonce: "" });

/**
 * Description and title text: NFKC, control, invisible and look-alike characters
 * neutralised, angle brackets escaped, bounded.
 */
export function sanitizeToolDescription(text: string): string {
  return escapeTags(cleaner.clean(text, MAX_MCP_DESCRIPTION_CHARS));
}

/** The JSON Schema keywords that pass; everything else (`$comment`, `x-*`, `examples`, ...) is dropped. */
export const SCHEMA_KEYWORDS: ReadonlySet<string> = new Set([
  "type",
  "properties",
  "required",
  "items",
  "prefixItems",
  "enum",
  "const",
  "anyOf",
  "oneOf",
  "allOf",
  "not",
  "additionalProperties",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "minLength",
  "maxLength",
  "format",
  "minItems",
  "maxItems",
  "uniqueItems",
  "default",
  "description",
  "title",
  "$ref",
  "$defs",
  "definitions",
]);

const JSON_TYPES = new Set(["string", "number", "integer", "boolean", "object", "array", "null"]);
const NUMERIC = new Set([
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
]);
const SCHEMA_MAPS = new Set(["properties", "$defs", "definitions"]);
const SCHEMA_LISTS = new Set(["prefixItems", "anyOf", "oneOf", "allOf"]);

export type SchemaSanitizeResult =
  | { readonly ok: true; readonly schema: Record<string, unknown> }
  | { readonly ok: false; readonly reason: string };

/** Thrown inside the walk; turned into `{ ok: false }` at the top. */
class Refused extends Error {}
const refuse = (reason: string): never => {
  throw new Refused(reason);
};

/**
 * A string that must reach the model and the server unchanged (a property name, an
 * enum value): it is refused rather than rewritten, because a cleaned copy would
 * no longer match what the server expects.
 */
function exactToken(v: string, what: string): string {
  if (v.length === 0) refuse(`${what} is empty`);
  if (v.length > MAX_SCHEMA_TOKEN_CHARS)
    refuse(`${what} is longer than ${MAX_SCHEMA_TOKEN_CHARS} chars`);
  if (/[<>]/.test(v)) refuse(`${what} contains "<" or ">"`);
  if (cleaner.clean(v, MAX_SCHEMA_TOKEN_CHARS) !== v || /[\n\t]/.test(v)) {
    refuse(`${what} contains control, invisible, look-alike or non-NFKC characters`);
  }
  // Short tokens, not prose: each enum / const string reaches the tool list
  // unfenced, so a run of words is refused (at most 3 whitespace characters).
  if ((v.match(/\s/g)?.length ?? 0) > MAX_TOKEN_SPACES) refuse(`${what} reads like prose`);
  return v;
}

/**
 * Total characters of all `enum` / `const` strings one tool's schema may carry. Each token is
 * already short and word-like (at most {@link MAX_SCHEMA_TOKEN_CHARS}, few spaces), but a
 * schema can hold many: a list of `ignore_previous_instructions`-style tokens is still text the
 * model reads unfenced. Over this, the tool is refused. Real enums (units, modes, languages,
 * region codes) stay far below it.
 */
export const MAX_SCHEMA_TOKEN_TOTAL_CHARS = 2048;

/** At most this many whitespace characters in an exact token (enum / const string). */
export const MAX_TOKEN_SPACES = 3;

/** Property names, `required` entries and `$defs` names: identifier-like, at most 64 chars. */
export const SCHEMA_NAME = /^[A-Za-z0-9_.-]{1,64}$/;

function schemaName(v: string, what: string): string {
  if (!SCHEMA_NAME.test(v)) refuse(`${what} must match ${SCHEMA_NAME}`);
  return v;
}

/** A JSON value (enum member, const): string leaves and object keys must be exact tokens. */
function exactValue(v: unknown, what: string, depth: number): unknown {
  if (depth > MAX_SCHEMA_DEPTH) refuse(`${what} is nested deeper than ${MAX_SCHEMA_DEPTH}`);
  if (typeof v === "string") return exactToken(v, what);
  if (v === null || typeof v === "number" || typeof v === "boolean") return v;
  if (Array.isArray(v)) return v.map((x) => exactValue(x, what, depth + 1));
  if (typeof v === "object") {
    return defineAll(
      Object.entries(v).map(([k, x]) => [
        exactToken(k, `${what} key`),
        exactValue(x, what, depth + 1),
      ]),
    );
  }
  return refuse(`${what} is not a JSON value`);
}

// defineProperty: a server key named `__proto__` stays a plain key.
function defineAll(entries: ReadonlyArray<readonly [string, unknown]>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, value] of entries) {
    Object.defineProperty(out, k, { value, enumerable: true, writable: true, configurable: true });
  }
  return out;
}

// An optional keyword whose value is unsafe is dropped instead of refusing the tool.
const optional = (f: () => unknown): unknown => {
  try {
    return f();
  } catch (e) {
    if (e instanceof Refused) return undefined;
    throw e;
  }
};

function walk(node: unknown, depth: number, path: string): unknown {
  if (depth > MAX_SCHEMA_DEPTH)
    refuse(`schema is nested deeper than ${MAX_SCHEMA_DEPTH} at ${path}`);
  if (typeof node === "boolean") return node;
  if (node === null || typeof node !== "object" || Array.isArray(node)) {
    return refuse(`schema at ${path} is not an object or boolean`);
  }
  const entries: Array<readonly [string, unknown]> = [];
  for (const [k, v] of Object.entries(node)) {
    if (!SCHEMA_KEYWORDS.has(k)) continue;
    const at = `${path}.${k}`;
    let out: unknown;
    if (k === "description" || k === "title") {
      out = typeof v === "string" ? sanitizeToolDescription(v) : undefined;
    } else if (k === "type") {
      const types = Array.isArray(v) ? v : [v];
      for (const t of types) {
        if (typeof t !== "string" || !JSON_TYPES.has(t)) refuse(`${at} has an unknown type`);
      }
      out = v;
    } else if (k === "required") {
      if (!Array.isArray(v)) refuse(`${at} is not an array`);
      out = (v as unknown[]).map((n) =>
        typeof n === "string"
          ? schemaName(n, `${at} entry`)
          : refuse(`${at} entry is not a string`),
      );
    } else if (k === "enum") {
      if (!Array.isArray(v)) refuse(`${at} is not an array`);
      out = exactValue(v, at, depth + 1);
    } else if (k === "const") {
      out = exactValue(v, at, depth + 1);
    } else if (k === "default") {
      out = optional(() => exactValue(v, at, depth + 1));
    } else if (k === "format") {
      out =
        typeof v === "string"
          ? optional(() => {
              if (/[<>]/.test(v) || v.length > MAX_MCP_DESCRIPTION_CHARS) refuse(at);
              if (cleaner.clean(v, MAX_MCP_DESCRIPTION_CHARS) !== v) refuse(at);
              return v;
            })
          : undefined;
    } else if (k === "$ref") {
      if (typeof v !== "string" || !v.startsWith("#/")) refuse(`${at} is not a local reference`);
      out = exactToken(v as string, at);
    } else if (NUMERIC.has(k)) {
      out = typeof v === "number" && Number.isFinite(v) ? v : undefined;
    } else if (k === "uniqueItems") {
      out = typeof v === "boolean" ? v : undefined;
    } else if (SCHEMA_MAPS.has(k)) {
      if (v === null || typeof v !== "object" || Array.isArray(v)) refuse(`${at} is not an object`);
      out = defineAll(
        Object.entries(v as object).map(([name, sub]) => [
          schemaName(name, `${at} name`),
          walk(sub, depth + 1, `${at}.${name}`),
        ]),
      );
    } else if (SCHEMA_LISTS.has(k)) {
      if (!Array.isArray(v)) refuse(`${at} is not an array`);
      out = (v as unknown[]).map((sub, i) => walk(sub, depth + 1, `${at}[${i}]`));
    } else if (k === "items") {
      out = Array.isArray(v)
        ? v.map((sub, i) => walk(sub, depth + 1, `${at}[${i}]`))
        : walk(v, depth + 1, at);
    } else {
      // additionalProperties, not
      out = walk(v, depth + 1, at);
    }
    if (out !== undefined) entries.push([k, out]);
  }
  return defineAll(entries);
}

/**
 * Reduce a server-supplied input schema to what the model needs, or refuse it.
 *
 * - Only {@link SCHEMA_KEYWORDS} pass; `$comment`, `x-*`, `examples` and unknown keys are dropped.
 * - `description` / `title`: cleaned, tags escaped, bounded (as tool descriptions).
 * - Property names, `required` entries, `$defs` names: {@link SCHEMA_NAME} (identifier-like,
 *   at most 64 chars), else the tool is refused.
 * - `enum` / `const` strings and `$ref`: must already be clean, at most
 *   {@link MAX_SCHEMA_TOKEN_CHARS} chars, without `<` or `>`, at most
 *   {@link MAX_TOKEN_SPACES} whitespace characters (a token, not prose); otherwise the tool is
 *   refused (a rewritten value would no longer match the server).
 * - `default` and `format` with such text are dropped instead. `pattern` is always dropped:
 *   a server-supplied regex run by a validator is a ReDoS risk.
 * - Over {@link MAX_SCHEMA_BYTES} serialised or {@link MAX_SCHEMA_DEPTH} deep: refused.
 */
export function sanitizeInputSchema(schema: unknown): SchemaSanitizeResult {
  let size: number;
  try {
    size = Buffer.byteLength(JSON.stringify(schema) ?? "", "utf8");
  } catch {
    return { ok: false, reason: "schema is not serialisable JSON" };
  }
  if (size > MAX_SCHEMA_BYTES) {
    return { ok: false, reason: `schema is ${size} bytes, over the ${MAX_SCHEMA_BYTES}-byte cap` };
  }
  try {
    const out = walk(schema, 0, "$");
    if (typeof out !== "object" || out === null) {
      return { ok: false, reason: "top-level schema must be an object" };
    }
    const tokenChars = enumConstChars(out, false);
    if (tokenChars > MAX_SCHEMA_TOKEN_TOTAL_CHARS) {
      return {
        ok: false,
        reason: `enum / const strings total ${tokenChars} chars, over the ${MAX_SCHEMA_TOKEN_TOTAL_CHARS}-char cap`,
      };
    }
    return { ok: true, schema: out as Record<string, unknown> };
  } catch (e) {
    if (e instanceof Refused) return { ok: false, reason: e.message };
    throw e;
  }
}

/** MCP tool names reach the model's tool list too; providers accept only this shape. */
export const MCP_TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;

/** Longest prefixed tool id (`<server>__<tool>`) the model sees: most providers cap names at 64. */
export const MAX_PREFIXED_TOOL_NAME = 64;

/**
 * Characters of every string under an `enum` or `const` keyword, anywhere in the schema.
 * Children of `properties` / `$defs` / `definitions` are keyed by NAME, so a property called
 * `enum` is not mistaken for the keyword.
 */
function enumConstChars(node: unknown, inToken: boolean, namesHere = false): number {
  if (typeof node === "string") return inToken ? node.length : 0;
  if (Array.isArray(node)) {
    return node.reduce((n: number, x) => n + enumConstChars(x, inToken), 0);
  }
  if (node === null || typeof node !== "object") return 0;
  let n = 0;
  for (const [k, v] of Object.entries(node)) {
    if (namesHere) n += enumConstChars(v, inToken);
    else {
      n += enumConstChars(v, inToken || k === "enum" || k === "const", SCHEMA_MAPS.has(k));
    }
  }
  return n;
}
