/**
 * 协作远端光标的块坐标（#517）：{blockIndex, offset} = 发送端 ProseMirror 文档的顶层块
 * 序号 + 块内偏移。两端之间过的是 markdown，所以「同一个序号指同一个块」的前提是
 * 序列化无损——空段落曾经在 markdown 里没有表示（#576），发送端敲出的空行在接收端
 * 根本不存在，序号越界被装饰器静默跳过，就是「presence 莫名消失」。空段落方言
 * （lib/editor/tiptap-empty-paragraph）收掉之后两端块结构一致，这里只剩兜底：
 * 发送端领先于尚未落地的保存帧、块内结构略有出入时，越界一律钳住，不管怎样光标
 * 永远落在**一个**位置上。
 */

import type { Node as PMNode } from "@tiptap/pm/model";

export type RemoteCursor = { blockIndex: number; offset: number };

/**
 * 远端坐标 → 本地文档绝对位置。序号命中就是「块内容起点 + 偏移」（偏移钳到块内容
 * 尺寸）；序号越界钳到末块尾。文档至少有一个块，所以总能落到一个位置。
 */
export function resolveRemoteCursorPos(doc: PMNode, cursor: RemoteCursor): number {
  const offset = Math.max(0, cursor.offset || 0);
  if (doc.childCount === 0) return 0;
  const overflow = cursor.blockIndex >= doc.childCount;
  const index = overflow ? doc.childCount - 1 : Math.max(0, cursor.blockIndex);
  let pos = 0;
  for (let i = 0; i < index; i++) pos += doc.child(i).nodeSize;
  const block = doc.child(index);
  return pos + 1 + (overflow ? block.content.size : Math.min(offset, block.content.size));
}
