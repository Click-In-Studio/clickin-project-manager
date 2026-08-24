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

/**
 * 往组里 index 处插一个空栏。与 removeColumnsAt 互为镜像，同样负责「栏数变了
 * 就清空所有 ratio」——旧宽度串是按旧栏数配的，留着会让 serializer 走进
 * ratios.length !== childCount 分支、主参数位整个不写。
 */
export function insertColumnAt(tr: Transaction, groupPos: number, index: number): boolean {
  const schema = tr.doc.type.schema;
  const colType = schema.nodes.column;
  const groupType = schema.nodes.columnGroup;
  const paraType = schema.nodes.paragraph;
  if (!colType || !groupType || !paraType) return false;
  const group = tr.doc.nodeAt(groupPos);
  if (!group || group.type !== groupType) return false;

  const cols: PMNode[] = [];
  for (let i = 0; i < group.childCount; i++) {
    cols.push(colType.create(null, group.child(i).content)); // 清 ratio
  }
  const idx = Math.max(0, Math.min(index, cols.length));
  cols.splice(idx, 0, colType.create(null, paraType.create()));
  tr.replaceWith(groupPos, groupPos + group.nodeSize, groupType.create(group.attrs, cols));
  return true;
}

/**
 * 一次性写入各栏宽度。用 setNodeMarkup 逐栏改 attr 而不是重建整组——重建会
 * 换掉所有节点、丢掉选区，而调宽度是个高频的连续操作。
 *
 * ratios 必须与栏数等长；serializer 只在**每一栏都有 ratio** 时才写主参数位
 * （见 tiptap-columns 的 columnGroup.serialize），所以只写一部分等于白写。
 */
export function setColumnRatios(tr: Transaction, groupPos: number, ratios: number[]): boolean {
  const group = tr.doc.nodeAt(groupPos);
  if (!group || group.type.name !== "columnGroup") return false;
  if (ratios.length !== group.childCount) return false;
  let pos = groupPos + 1;
  for (let i = 0; i < group.childCount; i++) {
    const col = group.child(i);
    tr.setNodeMarkup(pos, undefined, { ...col.attrs, ratio: ratios[i] });
    pos += col.nodeSize;
  }
  return true;
}

/**
 * 像素宽度 → 整数百分比，和恒为 100。
 *
 * 和必须精确是因为它要落进正文（`:::cols 46,54`）：99 或 101 都会让下次读回来
 * 的布局与用户当初看到的不一致。做法是前 n-1 项四舍五入、最后一项拿差值兜底，
 * 再保证每项至少 1（否则会出现 0% 的栏，视觉上等于消失但结构还在）。
 */
export function normalizeRatios(widths: number[]): number[] {
  const n = widths.length;
  if (n === 0) return [];
  const total = widths.reduce((a, b) => a + b, 0);
  if (!(total > 0)) {
    const even = Math.floor(100 / n);
    const out = Array<number>(n).fill(even);
    out[n - 1] = 100 - even * (n - 1);
    return out;
  }
  const out = widths.slice(0, -1).map(w => Math.max(1, Math.round((w / total) * 100)));
  let last = 100 - out.reduce((a, b) => a + b, 0);
  // 前面几项占满了 → 从最大的那项借一点给最后一项，保证每栏都 ≥1%
  while (last < 1) {
    const maxIdx = out.reduce((best, v, i) => (v > out[best] ? i : best), 0);
    if (out[maxIdx] <= 1) break;
    out[maxIdx] -= 1;
    last += 1;
  }
  out.push(last);
  return out;
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
