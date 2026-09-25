// @vitest-environment jsdom
// 正文回流后的 chip 文案（#689 的直接护栏）。
//
// 病因回放：正文里存的是哨兵 `[#](/__cm__/<kind>/<id>)`，显示位不带标签（语法大纲
// G4）。文档一重载，parseHTML 拿到的 label 就是 null——编辑态的 renderHTML 此前拿
// kind 名当兜底，于是读者看到的是 `#block` / `#scene`。这里钉两件事：
//   ① 回流后 label 恒为 null（前提成立，不是我们臆想的）
//   ② 把这个 null 喂进 chip 视图，出来的必须是读者看得懂的降级文案
// 真正把标签取回来的是 SmartTextarea 里那次 mention-resolve（覆盖全部 kind），
// 它的行为由 tests/script/script-mention-resolve.test.ts 与静态棘轮两头夹住。
import { describe, it, expect } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { Markdown } from "tiptap-markdown";
import { MarkdownContentMentionExt } from "@/lib/editor/tiptap-content-mention";
import { CONTENT_MENTION_KINDS } from "@/lib/editor/mention-types";
import { mentionChipView, wikiChipView } from "@/lib/editor/mention-display";

type Node = { kind: string; id: string; label: string | null; displayMode: string | null };

function mentionsOf(markdown: string): Node[] {
  const editor = new Editor({
    extensions: [StarterKit, Markdown.configure({ breaks: true }), MarkdownContentMentionExt],
    content: markdown,
  });
  const out: Node[] = [];
  editor.state.doc.descendants((n) => {
    if (n.type.name === "contentMention") {
      out.push({ kind: n.attrs.kind, id: n.attrs.id, label: n.attrs.label, displayMode: n.attrs.displayMode });
    }
  });
  editor.destroy();
  return out;
}

describe("哨兵正文回流成节点", () => {
  it("全部 kind 都解析成 contentMention 节点，attrs 齐备而 label 为 null", () => {
    const body = CONTENT_MENTION_KINDS.map(k => `[#](/__cm__/${k}/id-${k})`).join(" 和 ");
    const found = mentionsOf(body);
    expect(found.map(f => f.kind)).toEqual([...CONTENT_MENTION_KINDS]);
    for (const f of found) {
      expect(f.id).toBe(`id-${f.kind}`);
      expect(f.label, `${f.kind} 的 label 竟然不是 null——前提变了，本文件的推理要重做`).toBeNull();
    }
  });

  it("block 的 ?as= 展示模式随节点回来，不会丢成默认场模式", () => {
    const found = mentionsOf("[#](/__cm__/block/b1?as=page) [#](/__cm__/block/b1?as=rehearsal)");
    expect(found.map(f => f.displayMode)).toEqual(["page", "rehearsal"]);
  });
});

describe("回流后的 chip 文案", () => {
  it("未解析的剧本域 chip 说人话，不吐 kind 名", () => {
    for (const { kind } of mentionsOf(CONTENT_MENTION_KINDS.map(k => `[#](/__cm__/${k}/x)`).join(" "))) {
      const view = kind === "wiki" ? wikiChipView(null) : mentionChipView(kind, null);
      expect(view.muted, `${kind} 未解析却当成活引用`).toBe(true);
      expect(view.text, `${kind} 的 chip 又吐 kind 名`).not.toContain(kind);
      expect(view.text).not.toMatch(/^#?[a-z]+$/); // `#block` 那种形状
      expect(view.title).toBeTruthy();             // 降级必须给原因
    }
  });

  it("同一个 block 的两种展示模式喂进来标签不共用——键要带 displayMode", () => {
    const [scenePos, pagePos] = ["#0-1-3 李明：走了", "#p.4-2 李明：走了"];
    expect(mentionChipView("block", scenePos).text).not.toBe(mentionChipView("block", pagePos).text);
  });
});
