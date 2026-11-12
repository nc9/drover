/**
 * Conservative, syntactic JSON repair (#29): fixes what models commonly add around otherwise
 * well-formed JSON, and nothing else. Pure; no dependency.
 *
 * Repairs, outside string literals only:
 * - a leading byte-order mark;
 * - `//` line comments and `/* *\/` block comments;
 * - a trailing comma before `}` or `]`;
 * - typographic quotes (`“ ” „ ‟`, and `‘ ’` around keys or values) used as string
 *   delimiters, turned into `"`. The content between them is taken literally: a `"` is
 *   escaped, and so is a backslash, so `“a\nb”` becomes the four characters `a\nb`, not a
 *   newline (it was never a JSON escape there).
 *
 * Never repaired: truncation (an unclosed string, object or array is left as it is, so
 * `JSON.parse` still fails and the run spends a retry turn instead of accepting partial
 * data), single-quoted strings, unquoted keys, missing commas, `NaN` / `undefined`.
 *
 * Returns the repaired text, or `null` when nothing was changed.
 */
export function repairJson(text: string): string | null {
  let out = "";
  let changed = false;
  let i = 0;
  const n = text.length;
  if (text.charCodeAt(0) === 0xfeff) {
    i = 1;
    changed = true;
  }
  const OPEN_SMART = new Set(["“", "”", "„", "‟", "‘", "’"]);
  const closeFor = (c: string): ReadonlySet<string> =>
    c === "‘" || c === "’" ? new Set(["’", "‘"]) : new Set(["”", "“", "‟"]);
  while (i < n) {
    const c = text[i]!;
    if (c === '"') {
      // A JSON string: copy it verbatim, escapes included.
      let j = i + 1;
      while (j < n && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      if (j >= n) return changed ? out + text.slice(i) : null; // unclosed: leave as is
      out += text.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (OPEN_SMART.has(c)) {
      const closers = closeFor(c);
      let j = i + 1;
      let body = "";
      while (j < n && !closers.has(text[j]!)) {
        const d = text[j]!;
        body += d === '"' ? '\\"' : d === "\\" ? "\\\\" : d;
        j += 1;
      }
      if (j >= n) return changed ? out + text.slice(i) : null; // unclosed: leave as is
      out += `"${body}"`;
      changed = true;
      i = j + 1;
      continue;
    }
    if (c === "/" && text[i + 1] === "/") {
      while (i < n && text[i] !== "\n") i += 1;
      changed = true;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      if (end === -1) return changed ? out + text.slice(i) : null;
      i = end + 2;
      changed = true;
      continue;
    }
    if (c === ",") {
      // Look past whitespace and comments (removed later in this pass) for `}` / `]`.
      let j = i + 1;
      for (;;) {
        while (j < n && /\s/.test(text[j]!)) j += 1;
        if (text[j] === "/" && text[j + 1] === "/") {
          while (j < n && text[j] !== "\n") j += 1;
        } else if (text[j] === "/" && text[j + 1] === "*") {
          const end = text.indexOf("*/", j + 2);
          if (end === -1) break;
          j = end + 2;
        } else break;
      }
      if (text[j] === "}" || text[j] === "]") {
        changed = true;
        i += 1;
        continue;
      }
    }
    out += c;
    i += 1;
  }
  return changed ? out : null;
}
