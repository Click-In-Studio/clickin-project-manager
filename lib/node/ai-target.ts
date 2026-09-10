import type { NodeEntry } from "./db";

// 当前树节点 → AI 助手「附带当前对象」的主语（#476 follow-up）。
//
// 分派与 wiki 页面同源（app/production/[id]/wiki/[wikiId]/page.tsx）：wiki 节点
// 带文档、asset 壳节点带文件、link 解到目标再按目标 kind 分——页面渲染的本来就是
// 目标，link 自己不是内容、也不投权限票。分派只做在页面上、消费侧各猜各的，
// 就是 #476 那发 500 的成因，所以这份判据要是**一份**、可直接测。

export type AiTargetRef = { kind: "wiki" | "asset"; id: string };

/** 认不出来返回 null（folder、悬空 link、闭包外的目标）——调用方回落 pathname。 */
export function aiTargetForNode(
  selected: NodeEntry | undefined,
  byId: Map<string, NodeEntry>,
): AiTargetRef | null {
  if (!selected) return null;
  if (selected.kind === "wiki" && selected.wikiId) return { kind: "wiki", id: selected.wikiId };
  if (selected.kind === "asset" && selected.assetId) return { kind: "asset", id: selected.assetId };
  if (selected.kind === "link") {
    // wiki 目标有现成的解析字段（targetWikiId），目标不在自己的枚举闭包里也认得；
    // asset 目标没有对偶字段，只能查树，查不到就不报。
    if (selected.targetKind === "wiki" && selected.targetWikiId) {
      return { kind: "wiki", id: selected.targetWikiId };
    }
    const target = selected.linkTargetId ? byId.get(selected.linkTargetId) : undefined;
    if (target?.kind === "asset" && target.assetId) return { kind: "asset", id: target.assetId };
  }
  return null;
}
