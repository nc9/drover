// Tiny calculator module used by the rest of the app.
// Bugs intentionally seeded for the fix-code-bug eval.

export function add(a: number, b: number): number {
  // BUG: should be a + b
  return a - b;
}

export function multiply(a: number, b: number): number {
  return a * b;
}

export function average(nums: number[]): number {
  if (nums.length === 0) return 0;
  let total = 0;
  for (const n of nums) total = add(total, n);
  return total / nums.length;
}
