import type { WikiPlacement } from "./wiki-db";

// ─── 软链接路由的入参收口（#358，AI review #3）──────────────────────────────
//
// 路由拿到的是 `await req.json()`，运行时可以是任何东西。`body.parentId?.trim()`
// 这种写法对着一个数字就是 TypeError → 500：不是安全问题（门在后面），但一个成员
// 发个畸形请求就打出 500 是脏的。这里把「非字符串一律当没给」收在一处，两条路由
// 共用，别在每个字段各写一遍 typeof。

/** 非字符串 / 空白 → null（＝没给这个字段；对 parentId 就是顶层）。 */
export function readTrimmedId(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

/** 相对锚点：形状不对一律当没给，落位退化成尾部——不报错，与
 *  placementSortKey 里「锚点不在该父下就回落尾部」同一姿态。 */
export function readPlacement(v: unknown): WikiPlacement | null {
  if (!v || typeof v !== "object") return null;
  const { anchorId, side } = v as Record<string, unknown>;
  if (typeof anchorId !== "string" || anchorId.trim() === "") return null;
  if (side !== "before" && side !== "after") return null;
  return { anchorId: anchorId.trim(), side };
}
