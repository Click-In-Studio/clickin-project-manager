// 分栏方言渲染侧（react-markdown/remark）——与 lib/tiptap-columns 同一 canonical
// 形态：「:::cols 段落 … ::: 段落」区间、<hr>（thematicBreak）切栏。
// 纯 mdast 变换：段落序列 → wikiCols/wikiCol 节点（经 hName/hProperties 落成
// div.wiki-cols > div.wiki-col），react-markdown 侧零组件覆写。
// 不成对/单栏的 fence 原样保留为文字——降级可见不吃内容。
import { COLS_OPEN_RE, COLS_CLOSE_RE, parseColsRatios } from "./tiptap-columns";

type MdastNode = {
  type: string;
  children?: MdastNode[];
  value?: string;
  data?: { hName?: string; hProperties?: Record<string, unknown> };
};

function paragraphText(node: MdastNode): string | null {
  if (node.type !== "paragraph" || !node.children) return null;
  if (node.children.length !== 1 || node.children[0].type !== "text") return null;
  return node.children[0].value ?? null;
}

/** 对 mdast root 做分栏提升（导出纯函数供单测；remarkColumns 是其插件包装） */
export function transformColumns(root: MdastNode) {
  const kids = root.children;
  if (!kids) return;
  let i = 0;
  while (i < kids.length) {
    const text = paragraphText(kids[i]);
    const openMatch = text?.match(COLS_OPEN_RE) ?? null;
    if (!openMatch) { i++; continue; }
    let close = -1;
    for (let k = i + 1; k < kids.length; k++) {
      const t = paragraphText(kids[k]);
      if (t != null && COLS_CLOSE_RE.test(t)) { close = k; break; }
      if (t != null && COLS_OPEN_RE.test(t)) break; // 嵌套非法，放弃本组
    }
    if (close < 0) { i++; continue; }

    const inner = kids.slice(i + 1, close);
    const colsContent: MdastNode[][] = [[]];
    for (const n of inner) {
      if (n.type === "thematicBreak") colsContent.push([]);
      else colsContent[colsContent.length - 1].push(n);
    }
    if (colsContent.length < 2) { i = close + 1; continue; }

    const ratios = parseColsRatios(openMatch[1]);
    const group: MdastNode = {
      type: "wikiCols",
      data: { hName: "div", hProperties: { className: ["wiki-cols"] } },
      children: colsContent.map((blocks, idx) => {
        const r = ratios && ratios.length === colsContent.length ? ratios[idx] : null;
        return {
          type: "wikiCol",
          data: {
            hName: "div",
            hProperties: { className: ["wiki-col"], ...(r ? { style: `flex:0 1 ${r}%` } : {}) },
          },
          children: blocks,
        };
      }),
    };
    kids.splice(i, close - i + 1, group);
    i++;
  }
}

/** remark 插件形态 */
export default function remarkColumns() {
  return (tree: unknown) => {
    transformColumns(tree as MdastNode);
  };
}
