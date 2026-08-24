// 分栏方言 —— markdown 形态（拍板：显式组 fence，飞书同款不支持嵌套）：
//
//   :::cols 46,54        ← 参数位=各栏宽度百分比（可省略=均分）
//
//   左栏内容
//
//   ---                  ← 栏分隔符（水平线；前后空行必须——否则被当 setext 标题线）
//
//   右栏内容
//
//   :::
//
// 显式开闭 fence ⇒ 连续两组分栏天然区分。降级：不认方言的渲染器显示为
// 顺序段落 + 水平线 + 两行裸 :::，内容零丢失。局限（documented）：栏内
// 不能再放真水平线；不支持嵌套。
// 编辑器模型：columnGroup > column+（flex 并排）；roundtrip 走 canonical
// 形态（marker 独占段落），serializer 保证 canonical，保真锁安全。
import { Node, mergeAttributes } from "@tiptap/core";

// 参数位遵循布局类统一文法（语法大纲 §5.2）：`:::cols <主参数> [k=v ...]`
// 主参数 = 各栏宽度百分比（`46,54`），其余一律 k=v。本轮不新增任何 k=v 参数，
// 但**文法必须先能接**——否则将来加 `gap=24` 就得再动一次三落点，而旧版
// 解析器遇到不认识的参数会整组 fence 匹配失败（内容掉出分栏，属于吃结构）。
// 未知 k=v 一律忽略、不报错、不影响分栏成立。
export const COLS_OPEN_RE = /^:::cols(?:[ \t]+([^\n]*?))?[ \t]*$/;
export const COLS_CLOSE_RE = /^:::[ \t]*$/;

/** 解析开 fence 的宽度参数（"46,54" → [46,54]；"46,54 gap=24" 亦可；
 *  非法/缺失 → null）。k=v 参数被跳过。 */
export function parseColsRatios(params: string | undefined | null): number[] | null {
  if (!params) return null;
  // 主参数可含空格（`33, 33, 34` 是人手写的常见形态，canonical 序列化则无空格）：
  // 取开头连续的「纯数字/逗号」token 拼回来，遇到第一个 k=v（含 `=`）即停。
  const head = params.trim().split(/\s+/)
    .reduce<{ parts: string[]; done: boolean }>((acc, tok) => {
      if (acc.done || !/^[\d,]+$/.test(tok)) return { ...acc, done: true };
      return { parts: [...acc.parts, tok], done: false };
    }, { parts: [], done: false }).parts.join("");
  if (!head) return null; // 主参数位不是宽度串（缺失或只有 k=v）
  const nums = head.split(",").map(s => parseInt(s, 10)).filter(n => Number.isFinite(n) && n > 0);
  return nums.length >= 2 ? nums : null;
}

export const Column = Node.create({
  name: "column",
  content: "block+",
  defining: true,
  isolating: true,

  addAttributes() {
    return {
      // 宽度百分比（int，null=均分）；序列化时由 columnGroup 收集写进开 fence
      ratio: { default: null, parseHTML: (el: HTMLElement) => {
        const v = el.getAttribute("data-ratio");
        return v ? parseInt(v, 10) || null : null;
      } },
    };
  },

  parseHTML() {
    return [{ tag: "div[data-col]" }];
  },

  renderHTML({ node, HTMLAttributes }) {
    const ratio = node.attrs.ratio as number | null;
    return ["div", mergeAttributes(HTMLAttributes, {
      "data-col": "",
      ...(ratio ? { "data-ratio": String(ratio), style: `flex:0 1 ${ratio}%` } : {}),
      class: "wiki-col",
    }), 0];
  },

  addStorage() {
    return {
      markdown: {
        // column 自身不落任何标记——分隔与 fence 全由 columnGroup 写
        serialize(state: { renderContent: (n: unknown) => void }, node: unknown) {
          state.renderContent(node);
        },
        parse: {},
      },
    };
  },
});

type SerializerState = {
  write: (s: string) => void;
  closeBlock: (n: unknown) => void;
  renderContent: (n: unknown) => void;
};

export const ColumnGroup = Node.create({
  name: "columnGroup",
  group: "block",
  content: "column column+",
  defining: true,
  isolating: true,

  parseHTML() {
    return [{ tag: "div[data-cols]" }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes, { "data-cols": "", class: "wiki-cols" }), 0];
  },

  addStorage() {
    return {
      markdown: {
        serialize(state: SerializerState, node: { childCount: number; child: (i: number) => { attrs: { ratio?: number | null } }; forEach: (fn: (child: unknown, offset: number, index: number) => void) => void }) {
          const ratios: number[] = [];
          for (let i = 0; i < node.childCount; i++) {
            const r = node.child(i).attrs.ratio;
            if (r) ratios.push(r);
          }
          const params = ratios.length === node.childCount ? ` ${ratios.join(",")}` : "";
          state.write(`:::cols${params}`);
          state.closeBlock(node);
          node.forEach((col, _offset, index) => {
            if (index > 0) {
              state.write("---");
              state.closeBlock(col);
            }
            state.renderContent(col);
          });
          state.write(":::");
          state.closeBlock(node);
        },
        parse: {
          updateDOM(element: HTMLElement) {
            promoteColumnFences(element);
          },
        },
      },
    };
  },
});

/**
 * markdown 解析侧：markdown-it 渲染出的 DOM 里，把「:::cols 段落 … ::: 段落」
 * 区间提升为 div[data-cols] > div[data-col]，栏边界为区间内的 <hr>。
 * 只认 marker 独占段落的 canonical 形态（serializer 保证）；不成对的 fence
 * 原样保留为文字，降级可见不吃内容。
 */
export function promoteColumnFences(root: HTMLElement) {
  const doc = root.ownerDocument;
  const children = Array.from(root.children);
  let i = 0;
  while (i < children.length) {
    const el = children[i];
    const openMatch = el.tagName === "P" ? (el.textContent ?? "").match(COLS_OPEN_RE) : null;
    if (!openMatch) { i++; continue; }
    // 找关闭 fence
    let close = -1;
    for (let k = i + 1; k < children.length; k++) {
      const c = children[k];
      if (c.tagName === "P" && COLS_CLOSE_RE.test(c.textContent ?? "")) { close = k; break; }
      // 嵌套开 fence 非法：放弃本组
      if (c.tagName === "P" && COLS_OPEN_RE.test(c.textContent ?? "")) break;
    }
    if (close < 0) { i++; continue; }

    const inner = children.slice(i + 1, close);
    // 按 <hr> 切栏
    const colsContent: Element[][] = [[]];
    for (const c of inner) {
      if (c.tagName === "HR") {
        c.remove(); // 分隔符消费掉，不残留成真水平线
        colsContent.push([]);
      } else {
        colsContent[colsContent.length - 1].push(c);
      }
    }
    if (colsContent.length < 2) { i = close + 1; continue; } // 单栏不成组，保留原样

    const ratios = parseColsRatios(openMatch[1]);
    const group = doc.createElement("div");
    group.setAttribute("data-cols", "");
    colsContent.forEach((blocks, idx) => {
      const col = doc.createElement("div");
      col.setAttribute("data-col", "");
      const r = ratios && ratios.length === colsContent.length ? ratios[idx] : null;
      if (r) col.setAttribute("data-ratio", String(r));
      for (const b of blocks) col.appendChild(b);
      if (!col.hasChildNodes()) col.appendChild(doc.createElement("p"));
      group.appendChild(col);
    });
    children[close].remove();
    el.replaceWith(group);
    // 重新取快照继续扫（后续可能还有别的组）
    const rest = Array.from(root.children);
    i = rest.indexOf(group) + 1;
    children.length = 0;
    children.push(...rest);
  }
}
