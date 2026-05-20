import { TokenKind } from "liquidjs";
import type { TagToken, Template } from "liquidjs";

import { getBuiltin } from "./builtins.ts";
import type { CacheWarning, Volatility } from "./types.ts";

interface Classified {
  node: Template;
  volatility: Volatility;
  /** True for volatile builtin tags — the only nodes the reorder pass moves. */
  movable: boolean;
  /** Builtin name, when this node is a builtin tag. */
  builtin?: string;
  /** Human description used in warnings, e.g. `{% date %}` or `a {{ }} slot`. */
  what: string;
  /** 1-based source line. */
  line?: number;
}

function lineOf(node: Template): number | undefined {
  const pos = node.token.getPosition();
  return pos.length > 0 ? pos[0] : undefined;
}

/**
 * Classify one top-level template node.
 *
 * - HTML literals are static.
 * - Builtin tags carry their declared volatility; volatile builtins are
 *   the only nodes the reorder pass moves.
 * - `{{ }}` outputs and non-builtin (control-flow) tags are volatile and
 *   never moved. Control tags emit scope-dependent bytes, so they cannot
 *   sit inside a cacheable prefix — and reorder must not reach across
 *   control flow.
 */
function classify(node: Template): Classified {
  const kind = node.token.kind;
  const ln = lineOf(node);
  const withLine = <T extends Classified>(c: T): T => {
    if (ln !== undefined) c.line = ln;
    return c;
  };
  if (kind === TokenKind.Output) {
    return withLine({ node, volatility: "volatile", movable: false, what: "a {{ }} slot" });
  }
  if (kind === TokenKind.Tag) {
    const name = (node.token as TagToken).name;
    const builtin = getBuiltin(name);
    if (builtin) {
      return withLine({
        node,
        volatility: builtin.volatility,
        movable: builtin.volatility === "volatile",
        builtin: name,
        what: `{% ${name} %}`,
      });
    }
    // Non-builtin tag — control flow (`if`, `for`, `case`, …).
    return withLine({ node, volatility: "volatile", movable: false, what: `{% ${name} %}` });
  }
  // HTML literal.
  return { node, volatility: "static", movable: false, what: "static text" };
}

function toWarning(c: Classified, wasMoved: boolean): CacheWarning {
  const what = c.what;
  const at = c.line !== undefined ? ` (line ${c.line})` : "";
  const message = wasMoved
    ? `${what}${at} moved to a footer to extend the cacheable prefix`
    : `${what}${at} sits before static content — it shortens the cacheable prefix`;
  const w: CacheWarning = { message };
  if (c.line !== undefined) w.line = c.line;
  if (c.builtin !== undefined) w.builtin = c.builtin;
  return w;
}

export interface TemplateAnalysis {
  /** Top-level nodes in render order (reordered when applicable). */
  ordered: Template[];
  /** Count of leading nodes that are static — the cacheable prefix. */
  prefixCount: number;
  warnings: CacheWarning[];
  reordered: boolean;
}

/**
 * Classify a parsed template, find the cacheable prefix, and — when
 * `autoReorder` is set — relocate movable volatile builtin tags to the end
 * of the *leading* control-flow-free segment so the static prefix runs
 * contiguous.
 *
 * The first non-movable volatile node (a control tag like `{% if %}`, or a
 * `{{ }}` slot) is a hard barrier: it caps the cacheable prefix anyway, and
 * reorder never moves anything across it. So control flow is never
 * reordered around, and builtins past the barrier are left untouched
 * (moving them would not extend the prefix).
 */
export function analyzeTemplates(
  templates: ReadonlyArray<Template>,
  opts: { autoReorder: boolean },
): TemplateAnalysis {
  const cls = templates.map(classify);

  let lastStatic = -1;
  for (let i = 0; i < cls.length; i++) {
    if (cls[i]!.volatility === "static") lastStatic = i;
  }

  const offenders: Classified[] = [];
  for (let i = 0; i < cls.length; i++) {
    const c = cls[i]!;
    if (c.volatility === "volatile" && i < lastStatic) offenders.push(c);
  }

  // First non-movable volatile node — the reorder barrier.
  let barrier = cls.length;
  for (let i = 0; i < cls.length; i++) {
    const c = cls[i]!;
    if (c.volatility === "volatile" && !c.movable) {
      barrier = i;
      break;
    }
  }

  let orderedCls = cls;
  let reordered = false;
  const moved = new Set<Classified>();
  if (opts.autoReorder && barrier > 0) {
    const lead = cls.slice(0, barrier);
    // A movable builtin shortens the prefix only if static content follows
    // it within the leading segment.
    const hasOffender = lead.some(
      (c, i) => c.movable && lead.slice(i + 1).some((d) => !d.movable),
    );
    if (hasOffender) {
      const keep = lead.filter((c) => !c.movable);
      const movable = lead.filter((c) => c.movable);
      for (const c of movable) moved.add(c);
      orderedCls = [...keep, ...movable, ...cls.slice(barrier)];
      reordered = true;
    }
  }

  const warnings = offenders.map((o) => toWarning(o, moved.has(o)));

  let prefixCount = orderedCls.length;
  for (let i = 0; i < orderedCls.length; i++) {
    if (orderedCls[i]!.volatility === "volatile") {
      prefixCount = i;
      break;
    }
  }

  return { ordered: orderedCls.map((c) => c.node), prefixCount, warnings, reordered };
}
