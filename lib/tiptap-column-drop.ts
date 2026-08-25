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
import { dropPoint } from "@tiptap/pm/transform";
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

/**
 * x 是否落在块的左/右「边缘带」里。
 *
 * 边缘带对**块外侧**同样成立：x 在左沿之外时 `x - left` 为负，一样命中 left。
 * 这不是巧合而是刻意的——页边距是造栏最自然的起手区（把块往左一带、越过正文
 * 左沿），在那里必须仍然是竖线，否则会出现"再往外一点竖线突然变回横线"。
 */
export function edgeSide(rect: { left: number; right: number; width: number }, x: number): "left" | "right" | null {
  const band = Math.min(EDGE_MAX_PX, rect.width * EDGE_RATIO);
  if (x - rect.left <= band) return "left";
  if (rect.right - x <= band) return "right";
  return null;
}

/** 指示线粗细（px）。内建 dropcursor 默认 1px + currentColor，实测等于看不见 */
const INDICATOR_PX = 3;

export type IndicatorRect = { left: number; top: number; width: number; height: number };

/** 造栏竖线：贴在栏/块的某一侧，纵向铺满它的高度 */
export function verticalRect(line: LineRect, width: number): IndicatorRect {
  return {
    left: line.x - width / 2,
    top: line.top,
    width,
    height: Math.max(0, line.bottom - line.top),
  };
}

/**
 * 普通块间落点的横线几何 —— 复刻 prosemirror-dropcursor 的 updateOverlay：
 * 先用 dropPoint 把光标位置吸附到合法的插入点，再取相邻块的 DOM 矩形定横线
 * 的 y 与宽度；前后都有块时取两者的中缝。落在行内位置（例如往段落中间拖一段
 * 文字）则退化成一根细竖条，与内建行为一致。
 */
export function blockLineRect(view: EditorView, event: DragEvent, width: number): IndicatorRect | null {
  const at = view.posAtCoords({ left: event.clientX, top: event.clientY });
  if (!at) return null;
  let target = at.pos;
  const slice = view.dragging?.slice;
  if (slice) {
    const point = dropPoint(view.state.doc, target, slice);
    if (point != null) target = point;
  }
  const $pos = view.state.doc.resolve(target);
  if (!$pos.parent.inlineContent) {
    const before = $pos.nodeBefore;
    const after = $pos.nodeAfter;
    if (before || after) {
      const dom = view.nodeDOM(target - (before ? before.nodeSize : 0));
      if (dom && (dom as HTMLElement).nodeType === 1) {
        const r = (dom as HTMLElement).getBoundingClientRect();
        let y = before ? r.bottom : r.top;
        if (before && after) {
          const afterDom = view.nodeDOM(target);
          if (afterDom && (afterDom as HTMLElement).nodeType === 1) {
            y = (y + (afterDom as HTMLElement).getBoundingClientRect().top) / 2;
          }
        }
        return { left: r.left, top: y - width / 2, width: r.width, height: width };
      }
    }
  }
  try {
    const c = view.coordsAtPos(target);
    return { left: c.left - width / 2, top: c.top, width, height: Math.max(0, c.bottom - c.top) };
  } catch {
    return null; // 坐标算不出来就不画，别抛进拖放流程
  }
}

/**
 * 组内离 x 最近的栏边界。
 *
 * n 栏有 n+1 条边界：最左栏的左沿、每两栏之间缝的中点、最右栏的右沿。第 k 条
 * 边界对应「在 index=k 处插一栏」——这也是为什么「第 i 栏的右边缘」和「第
 * i、i+1 栏之间的缝」是同一件事。
 *
 * 竖线纵向铺满**整个组**的高度而不是某一栏的高度：落点是组级别的，贴着某一栏
 * 的高度画会让人以为只影响那一栏。
 */
function nearestColumnBoundary(
  view: EditorView, groupPos: number, group: PMNode, x: number,
): { index: number; line: LineRect } | null {
  const groupRect = rectOf(view, groupPos);
  if (!groupRect) return null;
  const rects: DOMRect[] = [];
  let pos = groupPos + 1;
  for (let i = 0; i < group.childCount; i++) {
    const r = rectOf(view, pos);
    if (!r) return null;
    rects.push(r);
    pos += group.child(i).nodeSize;
  }
  if (rects.length === 0) return null;

  const boundaries = columnBoundaries(rects);
  const index = pickBoundaryIndex(boundaries, x);
  return {
    index,
    line: { x: boundaries[index], top: groupRect.top, bottom: groupRect.bottom },
  };
}

/**
 * n 栏 → n+1 条边界的 x 坐标：最左栏的左沿、每两栏之间缝的中点、最右栏的右沿。
 * 第 k 条边界对应「在 index=k 处插一栏」。
 */
export function columnBoundaries(rects: { left: number; right: number }[]): number[] {
  const out = [rects[0].left];
  for (let i = 1; i < rects.length; i++) out.push((rects[i - 1].right + rects[i].left) / 2);
  out.push(rects[rects.length - 1].right);
  return out;
}

/** 离 x 最近的那条边界的下标。并列时取靠左的——插入语义上更符合直觉 */
export function pickBoundaryIndex(boundaries: number[], x: number): number {
  let best = 0;
  for (let i = 1; i < boundaries.length; i++) {
    if (Math.abs(x - boundaries[i]) < Math.abs(x - boundaries[best])) best = i;
  }
  return best;
}

/**
 * 纵向落在哪个顶层块的范围内（纯几何，不看 posAtCoords）。
 *
 * 为什么需要这条几何回退：光标落在**页边距**里时——编辑器自己的 padding-left
 * 就是——posAtCoords 给出的是 depth 0 的文档级位置，`$pos.node(1)` 根本不存在，
 * 拿不到"我正贴着哪个块"。而这恰恰是造栏最自然的起手区：人把块往左边一带，
 * 越过正文左沿进了页边距，期望的仍然是竖线（在这块左边分一栏）。
 *
 * 纵向落在两块之间的空隙里则返回 null —— 那种情形就该是横线（块间插入）。
 */
function topLevelBlockUnderPointer(view: EditorView, clientY: number): { pos: number; node: PMNode } | null {
  const doc = view.state.doc;
  let pos = 0;
  for (let i = 0; i < doc.childCount; i++) {
    const child = doc.child(i);
    const r = rectOf(view, pos);
    if (r && clientY >= r.top && clientY <= r.bottom) return { pos, node: child };
    pos += child.nodeSize;
  }
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
  const draggedIsColumn = draggedNode?.type === view.state.schema.nodes.column;

  // 光标在某个分栏组的范围内（栏里、栏间隙、组的沟槽都算）。
  // **组的范围内唯一有意义的落点就是栏边界**，一律由水平位置决定——所以这里
  // 不再区分"落在栏内"和"落在栏外的空隙里"，统一吸附到最近的边界。
  for (let d = $pos.depth; d >= 1; d--) {
    const node = $pos.node(d);
    if (node.type.name !== "columnGroup") continue;
    const groupPos = $pos.before(d);
    const nearest = nearestColumnBoundary(view, groupPos, node, event.clientX);
    if (!nearest) return { kind: "forbidden" };

    // 拖的是整栏：不存在"放进另一栏里面"这回事，任何位置都吸附到最近边界
    if (!draggedIsColumn) {
      // 拖的是普通块：只有栏边缘那条窄带才是落点。栏内其余地方是禁区——
      // 栏里没有块级落点（否则"分栏的单位是栏"这条就破了）
      const colDepth = d + 1 <= $pos.depth ? d + 1 : -1;
      if (colDepth > 0 && $pos.node(colDepth).type.name === "column") {
        const colRect = rectOf(view, $pos.before(colDepth));
        if (!colRect || !edgeSide(colRect, event.clientX)) return { kind: "forbidden" };
      }
    }

    return {
      kind: "insert",
      groupFrom: groupPos,
      groupTo: groupPos + node.nodeSize,
      index: nearest.index,
      line: nearest.line,
    };
  }

  // 定位「贴着哪个顶层块」。posAtCoords 在页边距里只给得出 depth 0 的文档级
  // 位置（$pos.node(1) 不存在），所以那里必须换几何来找——而页边距正是造栏
  // 最自然的起手区，丢了它就会出现"往左带一点，竖线突然变回横线"
  const located = $pos.depth >= 1
    ? { pos: $pos.before(1), node: $pos.node(1) }
    : topLevelBlockUnderPointer(view, event.clientY);
  if (!located) return null; // 纵向落在两块之间 → 该走横线
  const { pos: blockPos, node: block } = located;

  // 页边距里贴着一个分栏组：仍按栏边界处理（祖先链那条路只在光标真的落进
  // 栏里时才走得到）
  if (block.type.name === "columnGroup") {
    const nearest = nearestColumnBoundary(view, blockPos, block, event.clientX);
    if (!nearest) return null;
    return {
      kind: "insert",
      groupFrom: blockPos,
      groupTo: blockPos + block.nodeSize,
      index: nearest.index,
      line: nearest.line,
    };
  }

  // 普通顶层块：贴左/右边缘 → 就地包成两栏；中间地带交给默认的块间插入。
  // 注意边缘带对**块外侧**也成立：clientX 在块左沿之外时 x - rect.left 为负，
  // 一样命中 left。这正是"拖到页边距还应该是竖线"的实现
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

  addProseMirrorPlugins() {
    // **唯一一个**指示元素，横线竖线共用。
    //
    // 这里刻意不用内建的 prosemirror-dropcursor 画横线（装了本扩展的面会把它
    // 整个关掉，见 SmartTextarea）。试过靠 disableDropCursor + CSS 去抑制它，
    // 不可靠——它的 dragover 在禁用分支里什么都不做，既不清除已画上的横线也
    // 不重新计时（scheduleRemoval 是 5 秒），于是鼠标扫过普通区域画出的那条
    // 会一直挂着。协调两套指示系统本身就是错的路：只留一个元素，互斥就由
    // 「同一时刻只可能有一种形态」天然保证，不需要任何抑制。
    let indicator: HTMLElement | null = null;

    const hide = () => { if (indicator) indicator.style.display = "none"; };

    /** rect 用视口坐标（fixed 定位）：绕开 offsetParent 是谁的问题——
     *  编辑器外框可能 overflow:hidden，挂在里面会被裁掉 */
    const show = (rect: IndicatorRect, vertical: boolean) => {
      if (!indicator) {
        indicator = document.createElement("div");
        document.body.appendChild(indicator);
      }
      indicator.className = `wiki-drop-line ${vertical ? "is-vertical" : "is-horizontal"}`;
      indicator.style.display = "block";
      indicator.style.left = `${rect.left}px`;
      indicator.style.top = `${rect.top}px`;
      indicator.style.width = `${rect.width}px`;
      indicator.style.height = `${rect.height}px`;
    };

    return [new Plugin({
      key: columnDropKey,
      view: () => ({
        destroy() { indicator?.remove(); indicator = null; },
      }),
      props: {
        handleDOMEvents: {
          dragover: (view, event) => {
            const target = computeColumnDropTarget(view, event as DragEvent);
            if (target?.kind === "forbidden") {
              // 禁区：什么都不画。画横线等于谎称"这里能放"，比没有指示更糟
              hide();
            } else if (target) {
              show(verticalRect(target.line, INDICATOR_PX), true);
            } else {
              // 普通的块间落点，几何复刻自 prosemirror-dropcursor
              const rect = blockLineRect(view, event as DragEvent, INDICATOR_PX);
              if (rect) show(rect, false); else hide();
            }
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
