// Lexicographic ordering using base-36, 10-character fixed-width keys.
// Key space: '0000000000'–'zzzzzzzzzz' (36^10 ≈ 3.6 × 10^15 slots).
// 36^10 = 3,656,158,440,062,976 < Number.MAX_SAFE_INTEGER, so plain numbers are safe.
//
// 定宽 key 的空位是有限的：同一间隙同侧连续取中约 45 次就耗尽（#680 / #682）。所以这里
// 不提供「永远给个 key」的函数——取不到严格落在两侧之间的 key 时返回 null，由调用方把该
// 序列的 key 均匀重铺（initialKeys）后再取。各落点的重铺见 script-patch-db 的
// allocateInsertKeyInTx、node/db 的 allocateSiblingKey、script-marker-tx 的修复插入。

const ALPHA = '0123456789abcdefghijklmnopqrstuvwxyz';
const BASE = 36;
const LEN = 10;
const MAX = Math.pow(BASE, LEN) - 1; // 3,656,158,440,062,975
/** 单侧无界（追加到末尾 / 插到最前）时的固定步长：不往边界折半，追加可走 MAX/步长 次。
 *  36^5 ≈ 6.0e7：两次追加之间还能再折半插入约 25 次才需要重铺。 */
const OPEN_SIDE_STEP = Math.pow(BASE, 5);

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
 * 严格落在 lo 与 hi 之间的 key；间隙耗尽（两 key 相邻或相同）时返回 null，
 * 由调用方重铺该序列的 key。null 为 lo 表示「没有下界」，null 为 hi 表示「没有上界」；
 * 无界侧按固定步长走（不折半），两侧都无界给键空间中点。
 */
export function keyStrictlyBetween(lo: string | null, hi: string | null): string | null {
  const a = lo ? decode(lo) : -1;
  const b = hi ? decode(hi) : MAX + 1;
  if (b - a < 2) return null;
  if (!lo && !hi) return encode(Math.floor(MAX / 2));
  if (!hi && a + OPEN_SIDE_STEP <= MAX) return encode(a + OPEN_SIDE_STEP);
  if (!lo && b - OPEN_SIDE_STEP >= 0) return encode(b - OPEN_SIDE_STEP);
  return encode(Math.floor((a + b) / 2));
}

/**
 * 一次取 n 个严格递增、均匀分布在 lo 与 hi 之间的 key（连续插入一段新行时用，
 * 别逐个折半——那正是耗尽的走法）。空位不够 n 个时返回 null。
 */
export function keysBetween(lo: string | null, hi: string | null, n: number): string[] | null {
  if (n <= 0) return [];
  const a = lo ? decode(lo) : -1;
  const b = hi ? decode(hi) : MAX + 1;
  if (b - a < n + 1) return null;
  const step = (b - a) / (n + 1);
  return Array.from({ length: n }, (_, i) => encode(Math.floor(a + step * (i + 1))));
}

/** True if s is a valid 10-char base-36 sort key. */
export function isValidKey(s: unknown): s is string {
  return typeof s === 'string' && s.length === LEN && [...s].every(c => ALPHA.includes(c));
}
