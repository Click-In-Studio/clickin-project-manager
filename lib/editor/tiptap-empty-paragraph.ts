// 空段落方言（#576 / #517）—— markdown 形态：独占一行的 `&nbsp;`。
//
//   1. 甲
//   2. 乙
//
//   &nbsp;               ← 编辑器里的一个空行
//
//   1. 丙
//
// 编辑器文档模型比 markdown 富：**空段落在 markdown 里没有表示**。tiptap-markdown
// 默认的段落序列化器把它直接吃掉，于是相邻两个同类列表之间唯一的分隔物消失，
// CommonMark 把它们并成一个列表——协作时对方的「1.」变「3.」、再保存就把并了的
// 写回库，不可逆（#576）；远端光标按块序对齐时序号也因此越界（#517）。
//
// 选 `&nbsp;` 的理由：markdown-it 与 remark 都把它解析成「只含 U+00A0 的段落」，
// react-markdown 天然渲染成一个空行；不认方言的渲染器显示一个空白段落，内容零
// 丢失；它本身就是手写 markdown 里"强制空行"的民间惯用法。保真锁（lib/wiki/
// fidelity）把 U+00A0 当空白折叠，签名里不留痕，往返安静。
//
// 只在**会丢**的位置写：段落是父块的独生子时父块自己的形态就撑着位置
// （`- ` / `> ` / 空文档 = 空串），不写；表格单元格由 `|` 撑着，也不写。
import Paragraph from "@tiptap/extension-paragraph";
import type { Node as PMNode } from "@tiptap/pm/model";

export const EMPTY_PARAGRAPH_MD = "&nbsp;";
const NBSP = "\u00a0";

/**
 * 段落序列化到 markdown 后会消失：只含空白文本 / 软换行。图片、mention 等原子节点
 * 都有形态；空标题/空代码块/空引用/空列表/分割线各有 `## ` / ``` / `> ` / `1. ` / `---`。
 */
export function isVisuallyEmptyParagraph(node: PMNode): boolean {
  if (node.type.name !== "paragraph") return false;
  let onlyTextOrBreak = true;
  node.forEach((child) => {
    if (!child.isText && child.type.name !== "hardBreak") onlyTextOrBreak = false;
  });
  return onlyTextOrBreak && node.textContent.trim() === "";
}

/**
 * 解析侧：markdown-it 把 `&nbsp;` 行渲染成 `<p>\u00a0</p>`（U+00A0），这里还原成空 `<p></p>`。
 * 只认「整段就是一个 nbsp」——正文里夹着 nbsp 的段落是用户自己写的，不动。
 * 供 tiptap-markdown 的 parse.updateDOM 钩子与单测使用。
 */
export function restoreEmptyParagraphs(root: HTMLElement) {
  for (const p of Array.from(root.querySelectorAll("p"))) {
    const only = p.childNodes.length === 1 ? p.firstChild : null;
    if (only && only.nodeType === 3 /* TEXT_NODE */ && only.textContent === NBSP) p.textContent = "";
  }
}

type SerializerState = {
  inTable?: boolean;
  write: (s: string) => void;
  renderInline: (n: PMNode) => void;
  closeBlock: (n: PMNode) => void;
};

/** 替换 StarterKit 的 paragraph（`StarterKit.configure({ paragraph: false })`），扩展集里必须成对出现 */
export const MarkdownParagraph = Paragraph.extend({
  addStorage() {
    return {
      markdown: {
        serialize(state: SerializerState, node: PMNode, parent: PMNode) {
          const held = state.inTable || parent.childCount === 1;
          // 非空 / 位置有父块撑着：prosemirror-markdown 默认段落序列化
          if (held || !isVisuallyEmptyParagraph(node)) state.renderInline(node);
          else state.write(EMPTY_PARAGRAPH_MD);
          state.closeBlock(node);
        },
        parse: {
          updateDOM(element: HTMLElement) {
            restoreEmptyParagraphs(element);
          },
        },
      },
    };
  },
});
