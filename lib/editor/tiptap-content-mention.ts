// markdown 面的 contentMention 节点（#-引用 chip）：`[#](/__cm__/<kind>/<id>)` ⇄ 原子节点。
// 从 SmartTextarea 抽出来（#670）：编辑器交互的纯函数（lib/editor/editor-task-sync）
// 要在真实 schema 上跑测试，节点定义得是可独立 import 的零 node 依赖模块。
// renderHTML / suggestion 仍在 SmartTextarea 里 configure（它们要 productionId 与
// 触发器插件），这里只有 schema 与序列化。
import { Mention } from "@tiptap/extension-mention";
import {
  encodeMentionHref, decodeMentionHref, CM_HREF_PREFIX,
  type ContentMentionAttrs,
} from "./mention-types";

// Content mention — markdown mode: serialises as [#label](cm://...) links
export const MarkdownContentMentionExt = Mention.extend({
  name: "contentMention",
  addAttributes() {
    return {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ...(this.parent as any)?.(),
      kind: { default: "scene" },
      displayMode: { default: null },
      aux: { default: null },
      versionId: { default: null },
      label: { default: null },
    };
  },
  parseHTML() {
    return [
      { tag: "span[data-content-mention]" },
      {
        tag: "a",
        priority: 1001,
        getAttrs(el) {
          if (typeof el === "string") return false;
          const href = el.getAttribute("href") ?? "";
          if (!href.startsWith(CM_HREF_PREFIX)) return false;
          const attrs = decodeMentionHref(href);
          if (!attrs) return false;
          // wiki 链接文本恒为占位 "#"（见下方 serialize），textContent 剥完前缀后是
          // 空串——归一化成 null 而不是 ""，renderHTML 的 label ?? "文档" 才接得住
          const label = (el.textContent ?? "").replace(/^#/, "") || null;
          return { ...attrs, label };
        },
      },
    ];
  },
  addStorage() {
    return {
      markdown: {
        serialize(state: { write: (s: string) => void }, node: { attrs: ContentMentionAttrs }) {
          const { kind, displayMode, id, aux, versionId } = node.attrs;
          const href = encodeMentionHref({ kind, displayMode, id, aux, versionId });
          // 显示位恒为固定哨兵 "#"，**所有 kind 一视同仁**（语法大纲 G4：显示位是
          // 缓存不是真相）。原先只有 wiki 落 "#"、其余 kind 落 `#${label}`——那段
          // label 是编辑期快照，目标改名后就冻在正文里，看着像"链接坏了"。
          // 为什么不真的留空 `[](…)`：空链接文字在不认方言的渲染器里**完全不可见**，
          // 违反 G5「降级可读」；`#` 携带零信息、永不过期，是"留空"的可降级写法。
          state.write(`[#](${href})`);
        },
      },
    };
  },
});
