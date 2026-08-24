// 分栏的拖放 —— 造栏、移栏、以及「栏内没有块级落点」这条边界。
//
// 模型（与飞书一致，见 lib/tiptap-column-editing.ts 顶部）：分栏里的拖拽单位
// 是**栏**，不是栏里的块。由此得到三种落点，互不重叠：
//
//   顶层块的左/右边缘  → 就地把它和拖来的东西包成一个分栏组（造栏）
//   分栏组里的栏边界    → 往组里插一栏。注意「第 i 栏的右边缘」和「第 i、i+1
//                        栏之间的缝」是同一个位置，都归结为 index=i+1，所以
//                        不需要分别处理"拖到边缘"和"拖到两栏中间"
//   栏内的其它任何地方  → **禁止**。栏里没有块级落点，这次拖放整个吞掉
//
// 前提：分栏本来就是 N 栏（`columnGroup` 的 content 是 `column column+`），
// 二栏只是那个按钮的默认值。缺的从来不是 schema，是造栏的手势。
//
// 与内建 dropcursor 的分工：只要落点落进上面任一种情形，就由节点 spec 的
// disableDropCursor 让内建横线退场（prosemirror-dropcursor 支持函数形式），
// 我们自己画竖线或者干脆不画。不这么做的话横线竖线会同时出现。这也是为什么
// 不用「插件抢先 return true」——插件顺序里 dropcursor 排在我们前面，抢不到。
import { Extension } from "@tiptap/core";
import { Plugin, PluginKey, NodeSelection } from "@tiptap/pm/state";
import type { EditorState, Transaction } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import type { Node as PMNode } from "@tiptap/pm/model";
import { removeColumnsAt } from "./tiptap-column-editing";

/** 边缘感应带：固定 40px，但不超过目标自身宽度的 1/4——否则窄栏整个都是
 *  "边缘"，就没有普通落点可言了 */
const EDGE_MAX_PX = 40;
const EDGE_RATIO = 0.25;

export type LineRect = { x: number; top: number; bottom: number };

export type ColumnDropTarget =
  /** 目标是个普通顶层块 → 把它和拖来的东西包成新的分栏组 */
  | { kind: "wrap"; blockFrom: number; blockTo: number; side: "left" | "right"; line: LineRect }
  /** 目标已在分栏组里 → 往组里 index 处插一栏 */
  | { kind: "insert"; groupFrom: number; groupTo: number; index: number; line: LineRect }
  /** 落在栏内但不在栏边缘 —— 栏里没有块级落点，这次拖放作废 */
  | { kind: "forbidden" };

// ── 文档手术（纯函数，可测）─────────────────────────────────────────────────

/** 把拖来的东西变成一个「栏」。本来就是栏就直接用——再包一层就是栏套栏 */
function asColumn(dragged: PMNode, colType: PMNode["type"]): PMNode {
  return dragged.type === colType ? dragged : colType.create(null, dragged);
}

/** 摘掉源。拖的是整栏时必须走 removeColumnsAt——直接 delete 会把源组留成
 *  一栏，而 `column column+` 不允许 */
function detachSource(tr: Transaction, source: { from: number; to: number } | null, draggedIsColumn: boolean) {
  if (!source) return;
  if (draggedIsColumn) removeColumnsAt(tr, [source.from]);
  else tr.delete(source.from, source.to);
}

/**
 * 生成造栏 / 插栏事务。返回 null = 这次拖放不该由我们接管（调用侧回退默认行为）。
 */
export function buildColumnDropTransaction(
  state: EditorState,
  target: ColumnDropTarget,
  dragged: PMNode,
  source: { from: number; to: number } | null,
): Transaction | null {
  if (target.kind === "forbidden") return null;
  const colType = state.schema.nodes.column;
  const groupType = state.schema.nodes.columnGroup;
  if (!colType || !groupType) return null;

  // 栏不能嵌套（语法大纲 §5.4）。schema 允许 ≠ 方言允许：嵌套组序列化出来是
  // 套娃的 :::cols，解析侧遇到嵌套开 fence 会放弃整组，内容直接掉出分栏
  if (dragged.type === groupType) return null;

  if (source && targetInsideSource(target, source)) return null;

  const draggedIsColumn = dragged.type === colType;
  const tr = state.tr;
  detachSource(tr, source, draggedIsColumn);
  const map = (p: number) => (source ? tr.mapping.map(p) : p);

  if (target.kind === "wrap") {
    const from = map(target.blockFrom);
    const to = map(target.blockTo);
    const base = tr.doc.nodeAt(from);
    // 摘源之后目标可能已经不在原地——重新读一次，对不上就放弃，
    // 绝不按旧坐标硬写
    if (!base || base.nodeSize !== to - from) return null;
    if (base.type === groupType) return null; // 已是分栏组，该走 insert
    if (base.type === colType) return null;   // 栏只能在组里，不该被 wrap
    const dropped = asColumn(dragged, colType);
    const kept = colType.create(null, base);
    const cols = target.side === "left" ? [dropped, kept] : [kept, dropped];
    tr.replaceWith(from, to, groupType.create(null, cols));
    return tr;
  }

  const gFrom = map(target.groupFrom);
  const gTo = map(target.groupTo);
  const group = tr.doc.nodeAt(gFrom);
  // 源就在这个组里时，摘栏可能已经把整组拆掉了（原本两栏）——此时无组可插
  if (!group || group.type !== groupType || group.nodeSize !== gTo - gFrom) return null;

  // 重建整组：栏数变了就清空所有 ratio，与 changeColumnCount 同一条纪律
  const cols: PMNode[] = [];
  for (let i = 0; i < group.childCount; i++) {
    cols.push(colType.create(null, group.child(i).content));
  }
  const idx = Math.max(0, Math.min(target.index, cols.length));
  cols.splice(idx, 0, asColumn(dragged, colType));
  tr.replaceWith(gFrom, gTo, groupType.create(group.attrs, cols));
  return tr;
}

/**
 * 把一整栏拖到普通位置（顶层块之间）—— 栏在别处不成立，所以就地摊平成普通块。
 * 这就是「移走一栏 = 整栏被移走」的落地：栏从源组消失，内容整块搬到新位置。
 */
export function buildColumnUnwrapTransaction(
  state: EditorState,
  dropPos: number,
  column: PMNode,
  source: { from: number; to: number } | null,
): Transaction | null {
  if (column.type !== state.schema.nodes.column) return null;
  if (source && dropPos >= source.from && dropPos <= source.to) return null;
  const tr = state.tr;
  detachSource(tr, source, true);
  const at = tr.mapping.map(dropPos);
  try {
    tr.insert(at, column.content);
  } catch {
    return null; // 落点在新文档里不是合法的块边界
  }
  return tr.docChanged ? tr : null;
}

function targetInsideSource(target: ColumnDropTarget, source: { from: number; to: number }): boolean {
  if (target.kind === "forbidden") return false;
  const [from, to] = target.kind === "wrap"
    ? [target.blockFrom, target.blockTo]
    : [target.groupFrom, target.groupTo];
  return from >= source.from && to <= source.to;
}

// ── 几何判定（吃 DOM 矩形，浏览器侧）────────────────────────────────────────

function edgeSide(rect: DOMRect, x: number): "left" | "right" | null {
  const band = Math.min(EDGE_MAX_PX, rect.width * EDGE_RATIO);
  if (x - rect.left <= band) return "left";
  if (rect.right - x <= band) return "right";
  return null;
}

function rectOf(view: EditorView, pos: number): DOMRect | null {
  const dom = view.nodeDOM(pos);
  if (!dom || (dom as HTMLElement).nodeType !== 1) return null;
  return (dom as HTMLElement).getBoundingClientRect();
}

/**
 * 光标当前落在哪种情形。纯读取、无副作用——dragover 画线、handleDrop 落地、
 * 节点 spec 的 disableDropCursor 三处共用同一个判定，三者必须完全一致
 * （不一致就会出现「画了竖线但松手走了普通插入」这种鬼）。
 */
export function computeColumnDropTarget(view: EditorView, event: DragEvent): ColumnDropTarget | null {
  const dragging = view.dragging;
  if (dragging && dragging.slice.content.childCount !== 1) return null; // 多块拖拽走默认
  const draggedNode = dragging?.slice.content.firstChild ?? null;
  // 拖的是分栏组本身 → 不造栏（会嵌套）。在这里就挡掉，免得 disableDropCursor
  // 把内建指示也一起关了、变成"什么提示都没有"
  if (draggedNode?.type === view.state.schema.nodes.columnGroup) return null;

  const at = view.posAtCoords({ left: event.clientX, top: event.clientY });
  if (!at) return null;
  const $pos = view.state.doc.resolve(at.pos);

  // 落在某一栏里：用**栏**的矩形判边，于是"栏的右边缘"＝"两栏之间的缝"
  for (let d = $pos.depth; d >= 1; d--) {
    if ($pos.node(d).type.name !== "column") continue;
    const colPos = $pos.before(d);
    const groupPos = $pos.before(d - 1);
    const group = $pos.node(d - 1);
    const rect = rectOf(view, colPos);
    if (!rect) return { kind: "forbidden" };
    const side = edgeSide(rect, event.clientX);
    // 栏里没有块级落点：不在栏边缘就是禁区，不能退回默认的块间插入
    if (!side) return { kind: "forbidden" };
    return {
      kind: "insert",
      groupFrom: groupPos,
      groupTo: groupPos + group.nodeSize,
      index: $pos.index(d - 1) + (side === "right" ? 1 : 0),
      line: { x: side === "left" ? rect.left : rect.right, top: rect.top, bottom: rect.bottom },
    };
  }

  // 顶层块：拖到它左/右边缘 → 就地包成两栏；其余位置交给默认的块间插入
  if ($pos.depth < 1) return null;
  const blockPos = $pos.before(1);
  const block = $pos.node(1);
  const rect = rectOf(view, blockPos);
  if (!rect) return null;
  const side = edgeSide(rect, event.clientX);
  if (!side) return null;
  return {
    kind: "wrap",
    blockFrom: blockPos,
    blockTo: blockPos + block.nodeSize,
    side,
    line: { x: side === "left" ? rect.left : rect.right, top: rect.top, bottom: rect.bottom },
  };
}

// ── 扩展 ─────────────────────────────────────────────────────────────────────

export const columnDropKey = new PluginKey("columnDrop");

export const ColumnDrop = Extension.create({
  name: "columnDrop",

  // 只要落点属于我们管的三种情形（含禁区），就让内建 dropcursor 退场。
  // prosemirror-dropcursor 读的是**光标所在节点**的 spec，所以必须挂到所有
  // 节点上——extendNodeSchema 正是干这个的
  extendNodeSchema() {
    return {
      disableDropCursor: (view: EditorView, _pos: unknown, event: DragEvent) =>
        !!computeColumnDropTarget(view, event),
    };
  },

  addProseMirrorPlugins() {
    let indicator: HTMLElement | null = null;

    const hide = () => { if (indicator) indicator.style.display = "none"; };

    const show = (line: LineRect) => {
      if (!indicator) {
        indicator = document.createElement("div");
        indicator.className = "wiki-column-drop-line";
        document.body.appendChild(indicator);
      }
      // fixed + 视口坐标：绕开 offsetParent 是谁的问题（编辑器外框可能
      // overflow:hidden，挂在里面会被裁掉）
      indicator.style.display = "block";
      indicator.style.left = `${line.x}px`;
      indicator.style.top = `${line.top}px`;
      indicator.style.height = `${Math.max(0, line.bottom - line.top)}px`;
    };

    return [new Plugin({
      key: columnDropKey,
      view: () => ({ destroy() { indicator?.remove(); indicator = null; } }),
      props: {
        handleDOMEvents: {
          dragover: (view, event) => {
            const target = computeColumnDropTarget(view, event as DragEvent);
            if (target && target.kind !== "forbidden") show(target.line);
            else hide(); // 禁区不画线——没有指示本身就是"这里不能放"的表达
            return false; // 只画线，不拦事件
          },
          dragleave: () => { hide(); return false; },
          dragend: () => { hide(); return false; },
          drop: () => { hide(); return false; },
        },
        handleDrop: (view, event, slice, moved) => {
          hide();
          if (slice.content.childCount !== 1) return false;
          const dragged = slice.content.firstChild;
          if (!dragged) return false;

          const sel = view.state.selection;
          const source = moved && sel instanceof NodeSelection
            ? { from: sel.from, to: sel.to }
            : null;
          const target = computeColumnDropTarget(view, event as DragEvent);

          // 栏内的非边缘位置：整个吞掉。返回 false 会让 PM 走默认插入，
          // 那就等于"栏里有块级落点"了
          if (target?.kind === "forbidden") {
            event.preventDefault();
            return true;
          }

          const isColumn = dragged.type === view.state.schema.nodes.column;

          if (!target) {
            // 拖的是整栏、落在普通位置 → 栏在别处不成立，就地摊平成普通块
            if (!isColumn) return false;
            const at = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos;
            if (at == null) return false;
            const tr = buildColumnUnwrapTransaction(view.state, at, dragged, source);
            if (!tr) return false;
            event.preventDefault();
            view.dispatch(tr.scrollIntoView());
            return true;
          }

          const tr = buildColumnDropTransaction(view.state, target, dragged, source);
          if (!tr) return false; // 造不了栏就回退默认行为，别把这次拖放吞掉
          event.preventDefault();
          view.dispatch(tr.scrollIntoView());
          return true;
        },
      },
    })];
  },
});
