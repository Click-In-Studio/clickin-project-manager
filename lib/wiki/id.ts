// ─── wiki 内容 id 的形状闸（#476）───────────────────────────────────────────
//
// `[wikiId]` 路由段共用两种 id 是**有意设计**（#358 → #420）：真实文档是 UUID，
// 软链接 / 资产壳节点是 `nd_` 短 id，页面按前缀就地分派——302 到目标会把人弹出
// 作用域化工作区。但分派只做在页面上，凡是把这个段直接喂给 `$1::uuid` 的入口，
// 拿到 `nd_…` 就是 PG 22P02（invalid input syntax for type uuid）→ 未捕获 → 500。
//
// 所以每个 uuid 入口先过这道闸：形状不对＝不是文档，按「不存在 / 不可见」答，
// 不把非法输入丢给 PG 抛。本模块**不许有运行时依赖**——前端（AppShell 的
// 「附带当前文档」chip）也要用同一份判据，分叉即再来一发 500。
export const WIKI_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isWikiId(id: string): boolean {
  return WIKI_ID_RE.test(id);
}
