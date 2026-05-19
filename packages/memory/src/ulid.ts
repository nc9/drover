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
