// 栏宽拖拽 —— 栏与栏之间那条分割线：悬停高亮、左右拖动调宽度比例、顶端 ⊕
// 直接插一栏。
//
// 用 **widget decoration** 而不是 NodeView：分割线是纯编辑期的操作件，不属于
// 文档内容。decoration 不进正史、不参与序列化、不广播给协作端，天然安全（与
// 图片上传占位同一套路，见 lib/tiptap-upload-placeholder）。换成 NodeView 就
// 得改 column 节点本身，把编辑期 UI 混进方言定义里。
//
// 拖动期间只改 DOM 的行内 flex，**不发事务**：调宽度是连续动作，逐帧发事务会
// 把撤销栈冲垮（拖一次留几十步）。松手时一次性写入 ratio，撤销一步回到原状。
import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { EditorView } from "@tiptap/pm/view";
import type { Node as PMNode } from "@tiptap/pm/model";
import { insertColumnAt, setColumnRatios, normalizeRatios } from "./tiptap-column-editing";

/** 一栏最少占多宽（百分比）。再窄就没法放内容，也点不中它的分割线 */
const MIN_RATIO = 6;

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
  const onMove = (e: MouseEvent) => {
    dx = Math.max(minDx, Math.min(maxDx, e.clientX - startX));
    const next = widths.slice();
    next[index - 1] = leftW + dx;
    next[index] = rightW - dx;
    // 只改行内样式：拖动期间不发事务
    els.forEach((el, i) => { el.style.flex = `0 1 ${(next[i] / total) * 100}%`; });
  };

  const onUp = () => {
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
    document.body.classList.remove("wiki-col-resizing");
    // 行内样式交还给 renderHTML —— 落库的 ratio 才是真相，行内样式只是拖动
    // 期间的预览。不清掉的话，下一次 attr 变化重渲染会与它打架
    els.forEach(el => { el.style.flex = ""; });
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

/** 造一条分割线的 DOM。index 是它右侧那一栏的下标 */
function buildResizer(view: EditorView, getGroupPos: () => number, index: number): HTMLElement {
  const root = document.createElement("div");
  root.className = "wiki-col-resizer";
  root.contentEditable = "false";

  const line = document.createElement("div");
  line.className = "wiki-col-resizer-line";
  root.appendChild(line);

  const add = document.createElement("button");
  add.type = "button";
  add.className = "wiki-col-resizer-add";
  add.title = "在这里插入一栏";
  add.textContent = "＋";
  root.appendChild(add);

  // 拖动：按在线上就接管，preventDefault 掐掉 PM 的选区拖拽
  line.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const groupPos = getGroupPos();
    if (groupPos >= 0) startResize(view, groupPos, index, e);
  });

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
        decorations(state) {
          const decos: Decoration[] = [];
          state.doc.descendants((node, pos) => {
            if (node.type.name !== "columnGroup") return true;
            let childPos = pos + 1;
            for (let i = 0; i < node.childCount; i++) {
              if (i > 0) {
                // 挂在第 i 栏内容的**起点**：widget 会成为该栏 DOM 的首个子节点，
                // 再用 absolute 定位挪到栏左侧的栏间隙里
                decos.push(Decoration.widget(
                  childPos + 1,
                  // getPos 在 widget 已被移除时给 undefined —— 那时算不出组的
                  // 位置，交互直接放弃（返回 -1，调用侧会拒绝执行）
                  (view, getPos) => buildResizer(view, () => {
                    const at = getPos();
                    return at == null ? -1 : groupPosOf(view, at);
                  }, i),
                  { side: -1, key: `wiki-col-resizer-${i}`, ignoreSelection: true },
                ));
              }
              childPos += node.child(i).nodeSize;
            }
            return false; // 组不嵌套，不必再往下
          });
          return DecorationSet.create(state.doc, decos);
        },
      },
    })];
  },
});
