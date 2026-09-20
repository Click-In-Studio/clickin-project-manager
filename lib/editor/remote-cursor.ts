/**
 * 协作远端光标的块坐标（#517）：两端按「markdown 投影后的块序」对话。
 *
 * 光标是 {blockIndex, offset}，blockIndex 原本是发送端 ProseMirror 文档的顶层块序号。
 * 但两端之间传的是 markdown，而序列化有损：只含空白/软换行的空段落在 markdown 里没有
 * 表示，直接消失（#576）。发送端敲两次回车留的空行、文末回车准备写下一段，这些块在
 * 接收端根本不存在——发送端报的序号大于接收端的块数，装饰器只能静默跳过，头像 tooltip
 * 里的「第 N 段」却照常显示，就是「presence 莫名消失」。
 *
 * 所以这里把两边都投影到同一套坐标：发送端数序号时跳过会消失的块；接收端解析时
 * 同样跳过自己文档里会消失的块（它自己也可能正在敲空行），投影序号越界（发送端光标
 * 停在文末空行）钳到末块尾。不管序列化对不对，光标永远落在**一个**位置上，不会消失。
 *
 * 「会消失」的判据来自往返实测：空标题/空代码块/空引用/空列表/分割线都有 markdown
 * 形态（`## ` / ``` / `> ` / `1. ` / `---`），只有空白段落没有。
 */

import type { Node as PMNode } from "@tiptap/pm/model";

export type RemoteCursor = { blockIndex: number; offset: number };

/** 顶层块序列化到 markdown 后会消失：只含空白文本 / 软换行的段落（图片、mention 等原子节点都有形态） */
export function vanishesInMarkdown(node: PMNode): boolean {
  if (node.type.name !== "paragraph") return false;
  let onlyTextOrBreak = true;
  node.forEach((child) => {
    if (!child.isText && child.type.name !== "hardBreak") onlyTextOrBreak = false;
  });
  return onlyTextOrBreak && node.textContent.trim() === "";
}

/** 发送端：本地顶层块序号 → 投影序号（前面有几个会留在 markdown 里的块） */
export function projectBlockIndex(doc: PMNode, localIndex: number): number {
  let projected = 0;
  const end = Math.min(localIndex, doc.childCount);
  for (let i = 0; i < end; i++) if (!vanishesInMarkdown(doc.child(i))) projected++;
  return projected;
}

/**
 * 接收端：投影坐标 → 本地文档绝对位置。序号命中就是「块内容起点 + 偏移」（偏移钳到块内
 * 容尺寸——两端块内结构可能略有出入）；越界钳到最后一个会留在 markdown 里的块的末尾，
 * 整篇都是空行时钳到末块。文档至少有一个块，所以总能落到一个位置。
 */
export function resolveRemoteCursorPos(doc: PMNode, cursor: RemoteCursor): number {
  // 坐标来自远端帧：非有限数当 0（JSON 本身带不出 NaN，这里只是把意图写明）
  const offset = Number.isFinite(cursor.offset) ? Math.max(0, cursor.offset) : 0;
  if (doc.childCount === 0) return 0;
  let pos = 0;
  let projected = 0;
  let lastKept: { pos: number; size: number } | null = null;
  for (let i = 0; i < doc.childCount; i++) {
    const block = doc.child(i);
    if (!vanishesInMarkdown(block)) {
      if (projected === cursor.blockIndex) return pos + 1 + Math.min(offset, block.content.size);
      projected++;
      lastKept = { pos, size: block.content.size };
    }
    pos += block.nodeSize;
  }
  if (lastKept) return lastKept.pos + 1 + lastKept.size;
  const last = doc.child(doc.childCount - 1);
  return pos - last.nodeSize + 1 + last.content.size;
}
