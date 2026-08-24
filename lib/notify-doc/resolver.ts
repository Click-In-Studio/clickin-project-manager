// 服务端引用解析器（通知 variant 专用）。
//
// 页面侧走 /api/mention-resolve，逐观看者按权限解析。通知是在**没有观看者会话**
// 的上下文里生成的，只能直查库。两者的权限语义不同，这是有意的：
//   · 页面 = 谁在看就按谁的权限解析
//   · 通知 = 已经决定要发给这个人了，正文里的标签是"这条通知的内容"
// 所以这里只做 production 归属校验（不跨演出泄漏），不做逐人权限门。
//
// 目前覆盖 wiki / user 两类——它们是通知正文里实际会出现的引用（文档链接、
// @提及）。剧本域（scene/block/cue）的标签解析逻辑在 mention-resolve 路由里
// 有 400 行，抽出来是独立工作；在此之前它们走 resolve→null 的中性降级：
// 显示正文里的原文字，不漏裸 id、不漏私有 href。
import { getPool } from "../pg";
import type { RefResolver } from "./ast";

/** 建一个按 production 作用域的解析器。同一次渲染内做缓存，避免逐引用打库。 */
export function createNotifyRefResolver(productionId: string): RefResolver {
  const cache = new Map<string, { label: string; url: string | null } | null>();

  return async ({ type, id }) => {
    const key = `${type}:${id}`;
    const hit = cache.get(key);
    if (hit !== undefined) return hit;

    let out: { label: string; url: string | null } | null = null;
    const pool = getPool();
    try {
      if (type === "wiki") {
        const r = await pool.query<{ title: string | null }>(
          "SELECT title FROM wiki WHERE id = $1::uuid AND production_id = $2",
          [id, productionId],
        );
        // 跨 production 或已删除 → null（降级成中性文字，不泄漏别处的标题）
        if (r.rows[0]) {
          out = {
            label: r.rows[0].title ?? "（无标题文档）",
            url: `/production/${productionId}/wiki/${id}`,
          };
        }
      } else if (type === "user") {
        const r = await pool.query<{ name: string | null }>(
          "SELECT name FROM user_profile WHERE user_id = $1::uuid",
          [id],
        );
        if (r.rows[0]?.name) out = { label: r.rows[0].name, url: null };
      }
    } catch {
      out = null; // 解析失败不该拖垮整条通知
    }

    cache.set(key, out);
    return out;
  };
}
