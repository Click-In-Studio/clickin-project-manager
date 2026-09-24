// 行内样式方言的只读渲染侧（react-markdown / remark）——与 lib/editor/tiptap-inline-style
// 同一 canonical 形态（lib/editor/inline-style-dialect）。
//
// **不挂 rehype-raw**。remark 把行内 HTML 标签给成一个个 `html` 节点，这里只把
// 三种 canonical 开标签与其闭标签在**同一父节点内**配对、包成 span[data-fg] /
// span[data-bg] / u；配不上对的、拼法不是 canonical 的、跨父节点的，一律原样留作
// `html` 节点——react-markdown 把它显示成字面文字，降级可见不吃字（G5），
// 《语法大纲》§10「未知 HTML 当纯文本」这条护栏也照旧成立。
// 安全面因此与自造记号方案相同：这里不解释任何 HTML，只认三个字符串。
import { parseCanonicalOpenTag, SPAN_CLOSE_TAG, U_CLOSE_TAG } from "./inline-style-dialect";

type MdastNode = {
  type: string;
  value?: string;
  children?: MdastNode[];
  data?: { hName?: string; hProperties?: Record<string, unknown> };
};

/** 从 open 位置起找配对闭标签下标（同父节点内，按同名标签计深度）；找不到 -1 */
function findClose(kids: MdastNode[], open: number, isSpan: boolean): number {
  const openRe = isSpan ? /^<span[\s>]/i : /^<u\s*>$/i;
  const close = isSpan ? SPAN_CLOSE_TAG : U_CLOSE_TAG;
  let depth = 0;
  for (let k = open + 1; k < kids.length; k++) {
    const n = kids[k];
    if (n.type !== "html" || !n.value) continue;
    if (openRe.test(n.value)) depth++;
    else if (n.value === close || (!isSpan && /^<\/u\s*>$/i.test(n.value))) {
      if (depth === 0) return k;
      depth--;
    }
  }
  return -1;
}

/** 对一个 children 数组就地配对（递归进子节点与包起来的内容） */
function pairChildren(kids: MdastNode[]) {
  let i = 0;
  while (i < kids.length) {
    const n = kids[i];
    const open = n.type === "html" && n.value ? parseCanonicalOpenTag(n.value) : null;
    if (!open) {
      if (n.children) pairChildren(n.children);
      i++;
      continue;
    }
    const close = findClose(kids, i, open.kind !== "u");
    if (close < 0) { i++; continue; } // 落单开标签：留字面
    const inner = kids.slice(i + 1, close);
    pairChildren(inner);
    const wrapped: MdastNode = {
      type: "inlineStyle",
      data: open.kind === "u"
        ? { hName: "u" }
        : { hName: "span", hProperties: open.kind === "fg" ? { dataFg: open.color } : { dataBg: open.color } },
      children: inner,
    };
    kids.splice(i, close - i + 1, wrapped);
    i++;
  }
}

/** 对 mdast root 做行内样式配对（导出纯函数供单测；remarkInlineStyle 是其插件包装） */
export function transformInlineStyle(root: MdastNode) {
  if (root.children) pairChildren(root.children);
}

/** remark 插件形态 */
export default function remarkInlineStyle() {
  return (tree: unknown) => {
    transformInlineStyle(tree as MdastNode);
  };
}
