// 「从左侧树拖进正文」的拖拽载荷（#692）。
//
// 树（components/wiki/WikiShell）在 dragStart 写、编辑器（SmartTextarea handleDrop）
// 在落点读，两端只认这一个模块——此前 mime 字符串与 JSON 形状各写一份，加 asset
// 一类就要两边各改一次，还没有东西保证形状对得上。
//
// 落点**一律先落引用 chip**，不弹「引用 / 嵌入」面板（调研结论：飞书 / Notion 都
// 是拖入直接落默认形态，形态事后在 chip 上切；见 lib/editor/editor-embed-switch）。
// 所以载荷里只有「指向谁」，没有「以什么形态」。
//
// 零 node 依赖：客户端组件直接 import。
import type { ContentMentionAttrs } from "./mention-types";
import { CM_HREF_PREFIX } from "./mention-types";

export const WIKI_DRAG_MIME = "application/x-clickin-wiki";
export const ASSET_DRAG_MIME = "application/x-clickin-asset";

export type DragRef = { kind: "wiki" | "asset"; id: string; label: string };

type TreeDragSource = {
  kind: string;
  wikiId: string | null;
  assetId: string | null;
  targetWikiId: string | null;
  displayTitle: string | null;
};

/**
 * 树节点 → 拖拽引用。引用永远锚**真实目标**（#358 ⑦）：wiki 节点锚 wikiId、
 * 软链接锚目标 wikiId、asset 节点锚 assetId。folder 与指向素材的软链接（树条目
 * 没带目标 assetId）给 null——拖了也不成引用，树内排序照常。
 */
export function treeDragRef(item: TreeDragSource): DragRef | null {
  const label = item.displayTitle ?? "（无标题）";
  if (item.kind === "wiki" && item.wikiId) return { kind: "wiki", id: item.wikiId, label };
  if (item.kind === "link" && item.targetWikiId) return { kind: "wiki", id: item.targetWikiId, label };
  if (item.kind === "asset" && item.assetId) return { kind: "asset", id: item.assetId, label };
  return null;
}

/** 写进 dataTransfer：私有 mime 给编辑器，text/plain 给落到源码框 / 外部编辑器的人 */
export function writeDragRef(dt: { setData(type: string, data: string): void }, ref: DragRef): void {
  const mime = ref.kind === "wiki" ? WIKI_DRAG_MIME : ASSET_DRAG_MIME;
  dt.setData(mime, JSON.stringify({ id: ref.id, label: ref.label }));
  dt.setData("text/plain", `[#](${CM_HREF_PREFIX}/${ref.kind}/${ref.id})`);
}

/** 从 dataTransfer 读回；两种 mime 都没有、或 JSON 坏了、或没 id → null（不是我们的拖拽） */
export function readDragRef(dt: { getData(type: string): string } | null | undefined): DragRef | null {
  if (!dt) return null;
  for (const [mime, kind] of [[WIKI_DRAG_MIME, "wiki"], [ASSET_DRAG_MIME, "asset"]] as const) {
    const raw = dt.getData(mime);
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw) as { id?: unknown; label?: unknown };
      if (typeof parsed.id !== "string" || !parsed.id) return null;
      const label = typeof parsed.label === "string" && parsed.label ? parsed.label : (kind === "wiki" ? "文档" : "素材");
      return { kind, id: parsed.id, label };
    } catch {
      return null;
    }
  }
  return null;
}

/** 落成 contentMention 节点的 attrs。label 是编辑期快照，随后由标签活刷新覆盖。 */
export function dragRefMentionAttrs(ref: DragRef): ContentMentionAttrs & { label: string } {
  return { kind: ref.kind, displayMode: null, id: ref.id, aux: null, versionId: null, label: ref.label };
}
