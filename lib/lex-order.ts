// Lexicographic ordering using base-36, 10-character fixed-width keys.
// Key space: '0000000000'–'zzzzzzzzzz' (36^10 ≈ 3.6 × 10^15 slots).
// 36^10 = 3,656,158,440,062,976 < Number.MAX_SAFE_INTEGER, so plain numbers are safe.

const ALPHA = '0123456789abcdefghijklmnopqrstuvwxyz';
const BASE = 36;
const LEN = 10;
const MAX = Math.pow(BASE, LEN) - 1; // 3,656,158,440,062,975

function encode(n: number): string {
  const x = Math.round(Math.max(0, Math.min(MAX, n)));
  let s = '';
  let v = x;
  for (let i = 0; i < LEN; i++) {
    s = ALPHA[v % BASE] + s;
    v = Math.floor(v / BASE);
  }
  return s;
}

function decode(s: string): number {
  let n = 0;
  for (const c of s) {
    const d = ALPHA.indexOf(c);
    n = n * BASE + (d < 0 ? 0 : d);
  }
  return n;
}

/** Generate n evenly distributed sort keys covering the full key space. */
export function initialKeys(n: number): string[] {
  if (n === 0) return [];
  const step = Math.floor((MAX + 1) / (n + 1));
  return Array.from({ length: n }, (_, i) => encode(step * (i + 1)));
}

/**
 * Returns a sort key strictly between lo and hi.
 * Passing null for lo means "before all keys"; null for hi means "after all keys".
 */
export function keyBetween(lo: string | null, hi: string | null): string {
  const a = lo ? decode(lo) : 0;
  const b = hi ? decode(hi) : MAX;
  if (b > a) return encode(Math.floor((a + b) / 2));
  // Space exhausted — nudge past lo (extremely unlikely with 36^10 slots)
  return encode(Math.min(a + 1, MAX));
}

/** True if s is a valid 10-char base-36 sort key. */
export function isValidKey(s: unknown): s is string {
  return typeof s === 'string' && s.length === LEN && [...s].every(c => ALPHA.includes(c));
}

/**
 * 严格落在 lo 与 hi 之间的 key；间隙耗尽（两 key 相邻或相同）时返回 null，
 * 由调用方重铺该序列的 key（见 script-patch-db 的 allocateInsertKeyInTx）。
 * 背景（#680）：定宽 key 每次取中，同一间隙同侧连续插入约 45 次就耗尽；此时
 * keyBetween 会返回与 lo 相同的 key，ORDER BY sort_key 对同 key 的行顺序不定——
 * 批量插入的块散落、甚至排到下一段标记之后。null 为 lo 表示「没有下界」，null 为
 * hi 表示「没有上界」。
 */
export function keyStrictlyBetween(lo: string | null, hi: string | null): string | null {
  const a = lo ? decode(lo) : -1;
  const b = hi ? decode(hi) : MAX + 1;
  if (b - a < 2) return null;
  return encode(Math.floor((a + b) / 2));
}
