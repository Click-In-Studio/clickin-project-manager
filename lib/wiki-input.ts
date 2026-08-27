import type { WikiPlacement } from "./wiki-db";

// ─── wiki / 链接路由的入参收口（#358 AI review #3；#355 起两族路由共用）─────
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

/**
 * 落位锚点（#355）：显式 parentId 缺席时"挂到哪棵系统树下"的声明。
 *
 * 与上面两个"形状不对当没给"的姿态**相反**——这个字段一旦给错就是静默错落位：
 * 文档落到全库顶层、掉出目标工作区，而调用方以为成功了。合法值只有一个，认不出来
 * 就 400，不猜。
 */
export type WikiParentAnchor = "dramaturgy";
export function readParentAnchor(
  v: unknown,
): { ok: true; anchor: WikiParentAnchor | null } | { ok: false } {
  if (v === undefined || v === null) return { ok: true, anchor: null };
  if (v === "dramaturgy") return { ok: true, anchor: "dramaturgy" };
  return { ok: false };
}
