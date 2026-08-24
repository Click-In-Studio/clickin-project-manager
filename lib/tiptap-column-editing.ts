// 分栏的编辑不变量。
//
// 模型（与飞书一致）：**分栏里的编辑单位是「栏」，不是栏里的块。**
//   · 栏里可以放任意多个、任意类型的块
//   · 但栏里**没有块级手柄、也没有块级落点**——拖拽只在「栏」这个粒度上发生
//   · 栏不能嵌套
//   · **空栏是合法状态**，不自动回收；只有在空栏里按退格才删掉它
//
// 最后一条是刻意的：新建的栏天生就是空的，自动回收会让用户点完「＋栏」那一栏
// 当场消失。空栏该不该留是用户的意图，不该由编辑器去猜——所以给退格，不给
// 自动 GC。
//
// 唯一被强制维护的是 schema 层面绕不过去的那条：`columnGroup` 的 content 是
// `column column+`，**组不足两栏就不成立**。所以摘栏时剩一栏要拆组（内容原地
// 保留，绝不能丢），剩零栏才删。
import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { Transaction } from "@tiptap/pm/state";
import type { Node as PMNode } from "@tiptap/pm/model";

/** 空栏 = 只剩一个空段落。真正零子节点的栏在 schema 上不成立（content 是
 *  `block+`），PM 不会产出 */
export function isEmptyColumn(col: PMNode): boolean {
  return col.type.name === "column"
    && col.childCount === 1
    && col.child(0).type.name === "paragraph"
    && col.child(0).content.size === 0;
}

/**
 * 从文档里摘掉给定位置的若干栏，并维护「组至少两栏」：
 *   剩 ≥2 栏 → 重建组（顺带清空 ratio —— 旧宽度串是按旧栏数配的）
 *   剩 1 栏  → **拆组**，把这一栏的内容原地放回去（不是删掉，内容不能丢）
 *   剩 0 栏  → 整组删除
 *
 * positions 是各栏在 tr.doc 里的起始位置。返回是否真的改了文档。
 */
export function removeColumnsAt(tr: Transaction, positions: number[]): boolean {
  const colType = tr.doc.type.schema.nodes.column;
  const groupType = tr.doc.type.schema.nodes.columnGroup;
  if (!colType || !groupType) return false;

  // 按所属组归拢：同一组里摘多栏必须一次重建，逐栏改会让后面的坐标失效
  const byGroup = new Map<number, Set<number>>();
  for (const pos of positions) {
    if (pos < 0 || pos >= tr.doc.content.size) continue;
    const $pos = tr.doc.resolve(pos);
    if ($pos.parent.type !== groupType) continue;
    const groupPos = $pos.before($pos.depth);
    const set = byGroup.get(groupPos) ?? new Set<number>();
    set.add($pos.index($pos.depth));
    byGroup.set(groupPos, set);
  }
  if (byGroup.size === 0) return false;

  // 从后往前，前面的坐标才不会被前一次改写弄脏
  let changed = false;
  for (const [groupPos, indices] of [...byGroup].sort((a, b) => b[0] - a[0])) {
    const group = tr.doc.nodeAt(groupPos);
    if (!group || group.type !== groupType) continue;
    const keep: PMNode[] = [];
    for (let i = 0; i < group.childCount; i++) {
      if (!indices.has(i)) keep.push(group.child(i));
    }
    if (keep.length === group.childCount) continue;
    const from = groupPos;
    const to = groupPos + group.nodeSize;
    if (keep.length >= 2) {
      tr.replaceWith(from, to, groupType.create(
        group.attrs,
        keep.map(c => colType.create(null, c.content)),
      ));
    } else if (keep.length === 1) {
      tr.replaceWith(from, to, keep[0].content); // 拆组，内容原地保留
    } else {
      tr.delete(from, to);
    }
    changed = true;
  }
  return changed;
}

/** 找出嵌套在别的栏里的分栏组（新文档里的位置，深到浅） */
export function findNestedColumnGroups(doc: PMNode): number[] {
  const found: number[] = [];
  doc.descendants((node, pos, parent) => {
    if (node.type.name !== "columnGroup") return;
    // 父链上还有栏 = 嵌套
    if (parent && parent.type.name === "column") found.push(pos);
  });
  return found;
}

export const columnEditingKey = new PluginKey("columnEditing");

export const ColumnEditing = Extension.create({
  name: "columnEditing",

  addKeyboardShortcuts() {
    return {
      // 空栏里按退格 → 收掉这一栏。column 是 isolating 的，默认退格跨不出栏
      // 边界，不接管的话按下去毫无反应——用户会觉得"分栏删不掉"
      Backspace: () => {
        const { state, view } = this.editor;
        const { empty, $from } = state.selection;
        if (!empty) return false;
        if ($from.parent.type.name !== "paragraph" || $from.parent.content.size !== 0) return false;
        const depth = $from.depth - 1;
        if (depth < 1) return false;
        if (!isEmptyColumn($from.node(depth))) return false;
        const tr = state.tr;
        if (!removeColumnsAt(tr, [$from.before(depth)])) return false;
        view.dispatch(tr);
        return true;
      },
    };
  },

  addProseMirrorPlugins() {
    return [new Plugin({
      key: columnEditingKey,
      // 栏不能嵌套。拖放侧已经挡了，但正文还有别的入口（粘贴、AI 写入、
      // markdown 导入），所以在这里兜一道底：嵌套组一律就地拆平。
      // 不只是洁癖——嵌套组序列化出来是套娃的 :::cols，而解析侧
      // promoteColumnFences 遇到嵌套开 fence 会**放弃整组**，内容直接掉出分栏。
      appendTransaction: (transactions, _oldState, newState) => {
        if (!transactions.some(t => t.docChanged)) return null;
        const nested = findNestedColumnGroups(newState.doc);
        if (nested.length === 0) return null;
        const tr = newState.tr;
        // 从后往前拆，前面的坐标不受影响
        for (const pos of nested.sort((a, b) => b - a)) {
          const node = tr.doc.nodeAt(pos);
          if (!node || node.type.name !== "columnGroup") continue;
          // 把各栏内容顺次摊平回去
          let content = node.content.child(0).content;
          for (let i = 1; i < node.childCount; i++) {
            content = content.append(node.child(i).content);
          }
          tr.replaceWith(pos, pos + node.nodeSize, content);
        }
        return tr.docChanged ? tr : null;
      },
    })];
  },
});
