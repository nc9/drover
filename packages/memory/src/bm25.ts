/**
 * Tiny Okapi BM25 implementation over in-memory documents. No external
 * deps. Configured for short prose (k1=1.5, b=0.75). Tag matches add a
 * constant boost so curated tags don't get drowned out by body length.
 */

const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "has",
  "have", "i", "in", "is", "it", "of", "on", "or", "that", "the", "this",
  "to", "was", "were", "with", "you", "your", "we", "our",
]);

const K1 = 1.5;
const B = 0.75;
const TAG_BOOST = 1.0;

/** Tokenise: lowercase, split on non-word, drop stopwords + single chars. */
export function tokenise(text: string): string[] {
  if (!text) return [];
  const out: string[] = [];
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 2) continue;
    if (STOPWORDS.has(raw)) continue;
    out.push(raw);
  }
  return out;
}

export interface Doc {
  id: string;
  tokens: ReadonlyArray<string>;
  tagSet: ReadonlySet<string>;
}

/** Build a doc from an entry's text fields. Tokenises once. */
export function buildDoc(
  id: string,
  summary: string,
  body: string,
  tags: ReadonlyArray<string> | undefined,
): Doc {
  const tokens = [...tokenise(summary), ...tokenise(body), ...(tags ?? []).flatMap(tokenise)];
  const tagSet = new Set((tags ?? []).map((t) => t.toLowerCase()));
  return { id, tokens, tagSet };
}

export interface ScoredDoc {
  id: string;
  score: number;
}

/**
 * Score `query` against `docs`. Returns descending by score; entries
 * with score ≤ 0 are dropped.
 *
 * Idf is computed from the supplied doc set — recompute when docs change.
 */
export function bm25(query: string, docs: ReadonlyArray<Doc>): ScoredDoc[] {
  if (docs.length === 0) return [];
  const qTokens = tokenise(query);
  if (qTokens.length === 0) return [];

  // df: how many docs contain each query term at least once.
  const df = new Map<string, number>();
  for (const t of new Set(qTokens)) {
    let count = 0;
    for (const d of docs) if (d.tokens.includes(t)) count++;
    df.set(t, count);
  }
  const N = docs.length;
  const avgdl = docs.reduce((s, d) => s + d.tokens.length, 0) / N;

  const out: ScoredDoc[] = [];
  for (const d of docs) {
    const dl = d.tokens.length || 1;
    let score = 0;
    // Tag matches
    for (const qt of qTokens) {
      if (d.tagSet.has(qt)) score += TAG_BOOST;
    }
    // BM25
    const tf = new Map<string, number>();
    for (const t of d.tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
    for (const qt of qTokens) {
      const f = tf.get(qt);
      if (!f) continue;
      const dfq = df.get(qt) ?? 0;
      // Standard BM25 idf with +1 smoothing.
      const idf = Math.log(1 + (N - dfq + 0.5) / (dfq + 0.5));
      const num = f * (K1 + 1);
      const den = f + K1 * (1 - B + B * (dl / avgdl));
      score += idf * (num / den);
    }
    if (score > 0) out.push({ id: d.id, score });
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}
