// 栏宽拖拽 —— 栏与栏之间那条分割线：悬停高亮、左右拖动调宽度比例、顶端 ⊕
// 直接插一栏。
//
// 两件东西，各有各的理由：
//
// ① **分割线本身 = widget decoration**。它是纯编辑期的操作件，不属于文档内容
//    ——decoration 不进正史、不参与序列化、不广播给协作端（与图片上传占位同
//    一套路，见 lib/tiptap-upload-placeholder）。
//
// ② **column 挂一个 NodeView**，只为让拖动期间的实时预览活得下来。拖动时我们
//    直接改栏的行内 flex 而不发事务（调宽度是连续动作，逐帧发事务会把撤销栈
//    冲垮，拖一次留几十步），但 ProseMirror 的 DOMObserver 盯着 attributes，
//    一看到 style 变了就把该节点按文档状态重画，预览当场被抹平——表现就是
//    "拖的时候没反应，松手才跳过去"。NodeView 的 ignoreMutation 是官方留的
//    出口，prosemirror-tables 的列宽拖拽用的也是这套。
//
// 这个 NodeView **不碰方言**：它与 column 的 renderHTML 完全等价，序列化、
// 解析、markdown 形态一概不受影响，纯粹是编辑期的一层。
//
// 松手时才一次性写入 ratio，于是撤销一步就回到原状。
import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { EditorView, ViewMutationRecord } from "@tiptap/pm/view";
import type { Node as PMNode } from "@tiptap/pm/model";
import { insertColumnAt, setColumnRatios, normalizeRatios } from "./tiptap-column-editing";

/** 一栏最少占多宽（百分比）。再窄就没法放内容，也点不中它的分割线 */
const MIN_RATIO = 6;

/** 按节点的 ratio 把宽度写回 DOM（null = 均分，交还给 CSS 的 flex:1 1 0） */
function applyRatio(dom: HTMLElement, ratio: number | null) {
  if (ratio) {
    dom.setAttribute("data-ratio", String(ratio));
    dom.style.flex = `0 1 ${ratio}%`;
  } else {
    dom.removeAttribute("data-ratio");
    dom.style.flex = "";
  }
}

/**
 * column 的 NodeView —— **只为了一件事：让拖动期间的实时预览活得下来。**
 *
 * 拖动时我们直接改栏的行内 flex（不发事务，见 startResize）。但 ProseMirror
 * 的 DOMObserver 盯着 attributes，一看到 style 变了就把该节点按文档状态重画，
 * 预览当场被抹平——表现就是"拖的时候没反应，松手才跳过去"。
 * NodeView 的 ignoreMutation 是官方给的出口，prosemirror-tables 的列宽拖拽
 * 用的也是这套。
 *
 * 除此之外它与 renderHTML 完全等价：同样的 class / data-col / ratio 样式。
 */
class ColumnView {
  dom: HTMLElement;
  contentDOM: HTMLElement;

  constructor(node: PMNode) {
    const dom = document.createElement("div");
    dom.className = "wiki-col";
    dom.setAttribute("data-col", "");
    applyRatio(dom, node.attrs.ratio as number | null);
    this.dom = dom;
    this.contentDOM = dom; // 与 renderHTML 的 ["div", {...}, 0] 一致：内容直挂
  }

  update(node: PMNode) {
    if (node.type.name !== "column") return false;
    applyRatio(this.dom, node.attrs.ratio as number | null);
    return true;
  }

  // ViewMutationRecord 是 MutationRecord 与 {type:"selection"} 的联合，
  // 后者没有 MutationRecord 的字段，所以类型要按联合写
  ignoreMutation(m: ViewMutationRecord) {
    // 只放过**栏自己身上**的属性变更（那就是我们写的预览样式）。
    // 内容侧的变更、以及选区类变更照常交给 PM，否则真正的编辑会丢
    return m.type === "attributes" && m.target === this.dom;
  }
}

/** 组内各栏的 DOM 元素（顺序与 childCount 一致）；取不全则 null */
function columnElements(view: EditorView, groupPos: number, group: PMNode): HTMLElement[] | null {
  const out: HTMLElement[] = [];
  let pos = groupPos + 1;
  for (let i = 0; i < group.childCount; i++) {
    const dom = view.nodeDOM(pos);
    if (!dom || (dom as HTMLElement).nodeType !== 1) return null;
    out.push(dom as HTMLElement);
    pos += group.child(i).nodeSize;
  }
  return out;
}

/**
 * 开始拖动第 index 条分割线（它分开的是第 index-1 栏与第 index 栏）。
 *
 * 只有相邻两栏的宽度会变，其余栏纹丝不动——这是"调分割线"的字面语义，也是
 * 用户唯一能预期的行为。总宽守恒，所以拖动不会把组撑开或缩窄。
 */
function startResize(
  view: EditorView, groupPos: number, index: number, startEvent: MouseEvent,
): void {
  const group = view.state.doc.nodeAt(groupPos);
  if (!group || group.type.name !== "columnGroup") return;
  const els = columnElements(view, groupPos, group);
  if (!els || index <= 0 || index >= els.length) return;

  const widths = els.map(el => el.getBoundingClientRect().width);
  const total = widths.reduce((a, b) => a + b, 0);
  if (!(total > 0)) return;

  const minPx = (MIN_RATIO / 100) * total;
  const startX = startEvent.clientX;
  const leftW = widths[index - 1];
  const rightW = widths[index];
  // 拖动范围：两侧都不能瘦过下限。夹在这里而不是夹在最后，指针才不会"跑出去
  // 很远再拖回来时毫无反应"
  const minDx = -(leftW - minPx);
  const maxDx = rightW - minPx;

  document.body.classList.add("wiki-col-resizing");

  let dx = 0;
  let frame: number | null = null;

  const paint = () => {
    frame = null;
    const next = widths.slice();
    next[index - 1] = leftW + dx;
    next[index] = rightW - dx;
    // 拖动期间用**像素**而不是百分比：百分比的基准是容器内容宽，而容器宽里
    // 含着 34px 的栏间隙，按百分比算出来的宽度和指针位置对不齐（越多栏偏得
    // 越远）。像素是我们量出来的真值，1:1 跟手。
    // 同时锁死 grow/shrink（`0 0`）——留着 shrink 的话 flex 会二次分配，
    // 结果又跑偏。总宽守恒所以不会撑破容器。
    els.forEach((el, i) => { el.style.flex = `0 0 ${next[i]}px`; });
  };

  const onMove = (e: MouseEvent) => {
    dx = Math.max(minDx, Math.min(maxDx, e.clientX - startX));
    // mousemove 比屏幕刷新快得多，合并到下一帧再改样式，免得空跑布局
    if (frame == null) frame = requestAnimationFrame(paint);
  };

  const onUp = () => {
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
    document.body.classList.remove("wiki-col-resizing");
    if (frame != null) cancelAnimationFrame(frame);

    // 把行内样式按**当前文档状态**复原，而不是一律清空。清空的话，原本就带
    // ratio 的栏会在"拖了又拖回原位"（dx 归零、不发事务）之后丢掉自己的宽度，
    // 直到下一次 update 才回来
    const current = view.state.doc.nodeAt(groupPos);
    els.forEach((el, i) => {
      applyRatio(el, (current?.child(i)?.attrs.ratio ?? null) as number | null);
    });
    if (dx === 0) return;

    const finalWidths = widths.slice();
    finalWidths[index - 1] = leftW + dx;
    finalWidths[index] = rightW - dx;
    const tr = view.state.tr;
    if (setColumnRatios(tr, groupPos, normalizeRatios(finalWidths))) {
      view.dispatch(tr);
    }
  };

  document.addEventListener("mousemove", onMove);
  document.addEventListener("mouseup", onUp);
}

/**
 * 从 widget 自己的位置反推它所属分栏组的起点。
 *
 * 不能把建 decoration 时的坐标闭包进去：decoration 会按 doc 重建，但用户按下
 * 鼠标那一刻，别的事务（协作回灌、自己的上一个操作）可能已经把坐标顶掉了。
 * 每次交互现算才是对的。
 */
function groupPosOf(view: EditorView, widgetPos: number): number {
  const $p = view.state.doc.resolve(widgetPos);
  for (let d = $p.depth; d >= 1; d--) {
    if ($p.node(d).type.name === "columnGroup") return $p.before(d);
  }
  return -1;
}

type ResizerSpec = {
  /** ⊕ 会往这个下标插栏；也是可拖动时分割线右侧那一栏的下标 */
  index: number;
  /** 能不能拖。组的最外两端不能——没有邻栏可以跟它对分宽度 */
  resizable: boolean;
  /** 贴在所属栏的哪一侧 */
  edge: "left" | "right";
};

/**
 * 造一条分割线的 DOM。
 *
 * 组的最外两端（第一栏之前、最后一栏之后）也要有，但只带 ⊕、不带拖动：
 * 拖动的语义是"在相邻两栏之间重新分配宽度"，最外侧没有相邻栏，拖它没有意义；
 * 而"在最左/最右加一栏"是完全正当的需求，缺了就只能绕去手柄菜单。
 */
function buildResizer(view: EditorView, getGroupPos: () => number, spec: ResizerSpec): HTMLElement {
  const { index, resizable, edge } = spec;
  const root = document.createElement("div");
  root.className = "wiki-col-resizer"
    + (resizable ? "" : " is-add-only")
    + (edge === "right" ? " is-right" : "");
  root.contentEditable = "false";

  if (resizable) {
    const line = document.createElement("div");
    line.className = "wiki-col-resizer-line";
    root.appendChild(line);
  }

  const add = document.createElement("button");
  add.type = "button";
  add.className = "wiki-col-resizer-add";
  add.title = "在这里插入一栏";
  add.textContent = "＋";
  root.appendChild(add);

  // 拖动绑在**整个命中区**上，不是绑在那条 2px 的线上。绑到线上的话，hover
  // 高亮（挂在 16px 的命中区）与实际可按下的范围会差出一个数量级——看着能点，
  // 实际几乎按不中，表现就是"拖拽没反应"。
  // preventDefault 掐掉 PM 的选区拖拽。
  if (resizable) {
    root.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      const groupPos = getGroupPos();
      if (groupPos >= 0) startResize(view, groupPos, index, e);
    });
  }

  // ⊕：插一栏。用 mousedown 而不是 click —— click 之前编辑器会先失焦，
  // 而且 PM 可能已经把选区挪走了
  add.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const groupPos = getGroupPos();
    if (groupPos < 0) return;
    const tr = view.state.tr;
    if (insertColumnAt(tr, groupPos, index)) view.dispatch(tr);
  });

  return root;
}

export const columnResizeKey = new PluginKey("columnResize");

export const ColumnResize = Extension.create({
  name: "columnResize",

  addProseMirrorPlugins() {
    return [new Plugin({
      key: columnResizeKey,
      props: {
        // 挂 NodeView 而不是改 column 节点定义：编辑期的预览机制不该渗进方言
        nodeViews: {
          column: (node) => new ColumnView(node),
        },
        decorations(state) {
          const decos: Decoration[] = [];
          state.doc.descendants((node, pos) => {
            if (node.type.name !== "columnGroup") return true;
            // getPos 在 widget 已被移除时给 undefined —— 那时算不出组的位置，
            // 交互直接放弃（返回 -1，调用侧会拒绝执行）
            const mount = (at: number, spec: ResizerSpec, key: string) => decos.push(Decoration.widget(
              at,
              (view, getPos) => buildResizer(view, () => {
                const p = getPos();
                return p == null ? -1 : groupPosOf(view, p);
              }, spec),
              { side: -1, key, ignoreSelection: true },
            ));

            // 栏与栏之间的分割线：挂在**右侧那一栏**内容的起点，widget 于是成为
            // 该栏 DOM 的首个子节点，再用 absolute 挪进左边的栏间隙
            let childPos = pos + 1;
            for (let i = 1; i < node.childCount; i++) {
              childPos += node.child(i - 1).nodeSize;
              mount(childPos + 1, { index: i, resizable: true, edge: "left" }, `wiki-col-resizer-${i}`);
            }

            // 组最外两端的两个 ⊕ 挂在**组**上，不挂在首/末栏里。
            // 挂栏里的话末栏会同时背着「左侧分割线」和「右端 ⊕」两个 widget，
            // 实测就是那一栏出问题：竖线点不到、⊕ 插错位置、右端的 ⊕ 干脆不
            // 出现。一栏最多一个 widget，这类叠放问题就不存在了。
            mount(pos + 1, { index: 0, resizable: false, edge: "left" }, "wiki-col-add-start");
            mount(pos + node.nodeSize - 1, { index: node.childCount, resizable: false, edge: "right" }, "wiki-col-add-end");
            return false; // 组不嵌套，不必再往下
          });
          return DecorationSet.create(state.doc, decos);
        },
      },
    })];
  },
});
