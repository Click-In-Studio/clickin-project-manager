// @vitest-environment jsdom
// 引用 chip ⇄ 嵌入块互转（#692）。
//
// 语法只有一种：嵌入 = 引用加 `!`。所以这里全部断言序列化后的 markdown——转换
// 只许在同一个 `/__cm__/asset/<id>` 上加减一个 `!`，多一个字少一个字都是改坏正文。
// 几何 / hover 归组件（jsdom 没布局），文档手术是纯函数，在真实 schema 上跑。
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { Markdown } from "tiptap-markdown";
import { MarkdownContentMentionExt } from "@/lib/editor/tiptap-content-mention";
import { WikiImage } from "@/lib/wiki/tiptap-image";
import {
  chipMenuItems, mentionToEmbedTx, embedToMentionTx, embedToMentionReason,
  type EmbedCheck,
} from "@/lib/editor/editor-embed-switch";

function makeEditor(md: string) {
  return new Editor({
    extensions: [
      StarterKit,
      Markdown.configure({ breaks: true }),
      MarkdownContentMentionExt,
      WikiImage.configure({ resolveSrc: (s) => s }),
    ],
    content: md,
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const md = (e: Editor) => (e.storage as any).markdown.getMarkdown() as string;

function firstPos(editor: Editor, typeName: string): number {
  let found = -1;
  editor.state.doc.descendants((n, pos) => {
    if (found >= 0) return false;
    if (n.type.name === typeName) { found = pos; return false; }
    return true;
  });
  if (found < 0) throw new Error(`没有 ${typeName} 节点`);
  return found;
}

describe("引用 → 嵌入", () => {
  it("整段只有 chip：整段换成嵌入块，回流的哨兵正文 label 为 null → alt 为空", () => {
    const e = makeEditor("[#](/__cm__/asset/a1)");
    const tr = mentionToEmbedTx(e.state, firstPos(e, "contentMention"));
    expect(tr).not.toBeNull();
    e.view.dispatch(tr!);
    expect(md(e)).toBe("![](/__cm__/asset/a1)");
  });

  it("chip 带编辑期 label（刚插入 / 已活刷新）：label 进 alt", () => {
    const e = makeEditor("");
    e.commands.insertContent({
      type: "contentMention",
      attrs: { kind: "asset", displayMode: null, id: "a1", aux: null, versionId: null, label: "剧照.jpg" },
    });
    e.view.dispatch(mentionToEmbedTx(e.state, firstPos(e, "contentMention"))!);
    expect(md(e)).toBe("![剧照.jpg](/__cm__/asset/a1)");
  });

  it("chip 夹在文字中间：删掉 chip 与紧跟的一个空格，嵌入块放到这一段后面，不劈段", () => {
    const e = makeEditor("甲 [#](/__cm__/asset/a1) 乙");
    e.view.dispatch(mentionToEmbedTx(e.state, firstPos(e, "contentMention"))!);
    expect(md(e)).toBe("甲 乙\n\n![](/__cm__/asset/a1)");
  });

  it("非 asset 的 chip 不转（wiki / scene 没有嵌入形态）", () => {
    for (const kind of ["wiki", "scene", "cue", "block"]) {
      const e = makeEditor(`[#](/__cm__/${kind}/x1)`);
      expect(mentionToEmbedTx(e.state, firstPos(e, "contentMention")), kind).toBeNull();
      e.destroy();
    }
  });

  it("不是 chip 的位置给 null，不抛", () => {
    const e = makeEditor("普通段落");
    expect(mentionToEmbedTx(e.state, 0)).toBeNull();
  });

  it("列表项里只有 chip：首子必须是段落，退到「段后插块」路径而不是抛", () => {
    const e = makeEditor("- [#](/__cm__/asset/a1)");
    const tr = mentionToEmbedTx(e.state, firstPos(e, "contentMention"));
    expect(tr).not.toBeNull();
    e.view.dispatch(tr!);
    const out = md(e);
    expect(out).toContain("![](/__cm__/asset/a1)");
    expect(out).not.toContain("[#](");
  });
});

describe("嵌入 → 引用", () => {
  it("素材嵌入块换成一段只含 chip 的段落，alt 进 label", () => {
    const e = makeEditor("![剧照](/__cm__/asset/a1)");
    const pos = firstPos(e, "image");
    expect(embedToMentionReason(e.state.doc.nodeAt(pos))).toBeNull();
    e.view.dispatch(embedToMentionTx(e.state, pos)!);
    expect(md(e)).toBe("[#](/__cm__/asset/a1)");
    const chip = e.state.doc.nodeAt(firstPos(e, "contentMention"))!;
    expect(chip.attrs.kind).toBe("asset");
    expect(chip.attrs.id).toBe("a1");
    expect(chip.attrs.label).toBe("剧照");
  });

  it("外链图不在素材库里：灰掉给原因，事务为 null", () => {
    const e = makeEditor("![外图](https://example.com/x.png)");
    const pos = firstPos(e, "image");
    expect(embedToMentionReason(e.state.doc.nodeAt(pos))).toMatch(/外部链接/);
    expect(embedToMentionTx(e.state, pos)).toBeNull();
  });

  it("不是图片块也有原因，不抛", () => {
    const e = makeEditor("段落");
    expect(embedToMentionReason(e.state.doc.nodeAt(0))).toBeTruthy();
    expect(embedToMentionReason(null)).toBeTruthy();
  });

  it("嵌入 → 引用 → 嵌入 逐字复原（alt 经 label 往返不丢）", () => {
    const src = "上文\n\n![剧照](/__cm__/asset/a1)\n\n下文";
    const e = makeEditor(src);
    e.view.dispatch(embedToMentionTx(e.state, firstPos(e, "image"))!);
    expect(md(e)).toBe("上文\n\n[#](/__cm__/asset/a1)\n\n下文");
    e.view.dispatch(mentionToEmbedTx(e.state, firstPos(e, "contentMention"))!);
    expect(md(e)).toBe(src);
  });
});

describe("chip 悬浮条的项表：各 kind 同一套、灰掉必有原因", () => {
  const CHECKS: EmbedCheck[] = ["unknown", "checking", "yes", "no", "failed"];

  it("项的 id 与顺序对所有 kind 一致", () => {
    const base = chipMenuItems("asset", "yes").map(i => i.id);
    expect(base).toEqual(["open", "embed"]);
    for (const kind of ["wiki", "scene", "block", "cue", "page", "rehearsal", "task", "未知kind"]) {
      expect(chipMenuItems(kind, "yes").map(i => i.id), kind).toEqual(base);
    }
  });

  it("只有 asset 且查到有嵌入形态时「转为嵌入」才亮；其余一律灰且原因非空", () => {
    for (const kind of ["asset", "wiki", "scene", "未知kind"]) {
      for (const check of CHECKS) {
        const embed = chipMenuItems(kind, check).find(i => i.id === "embed")!;
        const shouldEnable = kind === "asset" && check === "yes";
        expect(!embed.disabledReason, `${kind}/${check}`).toBe(shouldEnable);
        if (embed.disabledReason) expect(embed.disabledReason.length).toBeGreaterThan(0);
      }
    }
  });

  it("「打开」永远可用；非 asset 的原因用读者语言里的类别名，不露 kind 名", () => {
    expect(chipMenuItems("scene", "unknown")[0].disabledReason).toBeUndefined();
    const reason = chipMenuItems("scene", "unknown")[1].disabledReason!;
    expect(reason).toContain("场次");
    expect(reason).not.toMatch(/\bscene\b/);
  });
});

describe("接线棘轮", () => {
  it("BlockMenu：图片块的「转为引用」走 embedToMentionTx，灰化用 aria-disabled 不用 disabled 属性", () => {
    const src = readFileSync("components/editor/BlockMenu.tsx", "utf8");
    expect(src).toContain("embedToMentionTx(editor.state, block.pos)");
    expect(src).toContain("embedToMentionReason(block.node)");
    expect(src).toMatch(/aria-disabled=\{disabled\}/);
    expect(src).not.toMatch(/\sdisabled=\{disabled\}/);
  });

  it("SmartTextarea：挂了 chip 悬浮条，点击跳转与悬浮条「打开」同一个函数", () => {
    const src = readFileSync("components/editor/SmartTextarea.tsx", "utf8");
    expect(src).toMatch(/<MentionChipMenu editor=\{editor\} productionId=/);
    expect(src).toContain("navigateToMention(pid, node.attrs as ContentMentionAttrs)");
    // 旧的内联跳转逻辑不许残留（两处各写一份就会各自漂）
    expect(src.match(/mention-resolve`/g)?.length ?? 0).toBe(1);
  });

  it("MentionChipMenu：项表来自 chipMenuItems，灰化用 aria-disabled + title", () => {
    const src = readFileSync("components/editor/MentionChipMenu.tsx", "utf8");
    expect(src).toContain("chipMenuItems(target.attrs.kind");
    expect(src).toMatch(/aria-disabled=\{!!item\.disabledReason\}/);
    expect(src).toMatch(/title=\{item\.disabledReason\}/);
    expect(src).not.toMatch(/\sdisabled=/);
  });
});
