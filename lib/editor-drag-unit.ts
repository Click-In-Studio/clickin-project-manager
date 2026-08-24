// 块手柄的命中规则 —— 决定「鼠标停在这里，手柄该指向哪个节点」。
//
// 通则：**每种容器只认一个拖拽单位，容器内部的块一律不给手柄。**
//
//   分栏 → 栏（不是栏里的块，也不是整个组）
//   表格 → 整张表（不是行、不是单元格、也不是单元格里的段落）
//
// 不定死的话，命中评分会在「容器里的块」和「容器」之间摇摆——同一个位置有时
// 出手柄有时不出，出的那个多半还按不到，因为它被容器的边框/内边距挡着。
// 表格里"时有时无的块"就是这么来的。
//
// 抽成 lib 而不是留在组件里，是因为这段逻辑踩过一个不看代码根本发现不了的坑，
// 见下面 scoreDragTarget 的注释——它值得有测试盯着。
import type { Node as PMNode } from "@tiptap/pm/model";

/** 这些节点自身就是拖拽单位；它们**内部**的一切都不给手柄 */
export const HANDLE_CONTAINERS = new Set(["column", "table"]);

/** 官方 DragHandle 传给规则的上下文（只取我们用得到的三个字段） */
export type DragRuleContext = {
  node: PMNode;
  /** 候选节点自身在文档树中的深度 */
  depth: number;
  /** **光标**位置的 ResolvedPos —— 注意不是候选节点的位置 */
  $pos: { depth: number; node: (d: number) => PMNode };
};

/**
 * 评分：0 = 可作为手柄目标，≥1000 = 排除。
 *
 * **坑**：`$pos` 是鼠标所在位置的 ResolvedPos，而候选节点是
 * `$pos.node(depth)`（官方实现里候选就是这么枚举出来的）。也就是说
 * `$pos.node(d)` 在 `d === depth` 时给的**就是候选节点自己**，比 depth 更深的
 * 那几层则是它的后代。
 *
 * 所以判断"祖先里有没有容器"必须从 `depth - 1` 起步。从 `$pos.depth` 起步会
 * 把候选自己一并算进去，于是 table 和 column **自我排除**——表现就是整张表
 * （和整栏）的手柄凭空消失。
 */
export function scoreDragTarget({ node, depth, $pos }: DragRuleContext): number {
  // 分栏组本身不给手柄：要整组操作，用手柄菜单里的「选中整个分栏」
  if (node.type.name === "columnGroup") return 1000;
  for (let d = depth - 1; d >= 1; d--) {
    if (HANDLE_CONTAINERS.has($pos.node(d).type.name)) return 1000;
  }
  return 0;
}
