/**
 * Minimal Crockford base32 ULID generator (26 chars; first 10 encode a
 * millisecond timestamp, last 16 are random). Sortable by creation
 * time. No external deps.
 *
 * Implementation note: we use `crypto.getRandomValues` for the random
 * tail. Monotonic same-millisecond ordering isn't guaranteed; for the
 * memory use case (one write per turn at most), clock collisions are
 * vanishingly rare and not load-bearing.
 */

import { createHash } from "node:crypto";

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function ulid(now: number = Date.now()): string {
  const ts = encodeTime(now);
  const rand = encodeRandom();
  return ts + rand;
}

function encodeTime(now: number): string {
  let out = "";
  let n = now;
  for (let i = 0; i < 10; i++) {
    out = ALPHABET[n & 0x1f]! + out;
    n = Math.floor(n / 32);
  }
  return out;
}

function encodeRandom(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const b of bytes) out += ALPHABET[b & 0x1f]!;
  return out;
}

/**
 * Deterministic, ULID-shaped id derived from a seed string. Same seed
 * always yields the same 26-char Crockford-base32 id, so re-seeding the
 * same source (e.g. an instruction file path) is an idempotent upsert
 * rather than an accumulation.
 *
 * Not time-sortable — unlike `ulid()`, the id carries no timestamp.
 */
export function stableId(seed: string): string {
  const hash = createHash("sha256").update(seed).digest();
  let out = "";
  for (let i = 0; i < 26; i++) {
    out += ALPHABET[hash[i]! & 0x1f]!;
  }
  return out;
}
