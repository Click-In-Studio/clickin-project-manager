// @vitest-environment jsdom
// `/` 指令源（语法大纲 §6.2 第四个注册项）两面测试：
//   ① 查询迷你语言 —— 子串 / 别名 / 拼音三路匹配
//   ② **每条指令落地的 markdown 必须 roundtrip 逐字复原**
//
// ② 才是这个文件的重点。`/` 是布局类方言的**唯一插入入口**（固定工具栏收掉
// 之后），一条指令若落出非 canonical 形态，用户的下一次保存就会触发保真锁被
// 踢回源码模式——而那是事后止损，不是预防（调研文档 §3.3）。所以每加一条
// 指令都必须在这里过一遍往返。
import { describe, it, expect } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { TableKit } from "@tiptap/extension-table";
import { TaskList, TaskItem } from "@tiptap/extension-list";
import { Markdown } from "tiptap-markdown";
import { Callout } from "@/lib/tiptap-callout";
import { Column, ColumnGroup } from "@/lib/tiptap-columns";
import { SLASH_COMMANDS, searchSlashCommands } from "@/lib/editor-slash-commands";

// 与 SmartTextarea 同一套扩展集（「一切文本皆文档」之后全站只有这一套 schema）
function makeEditor(content: string) {
  return new Editor({
    extensions: [
      StarterKit,
      Markdown.configure({ transformCopiedText: true, breaks: true }),
      TableKit.configure({ table: { resizable: false } }),
      TaskList, TaskItem.configure({ nested: true }),
      Callout, Column, ColumnGroup,
    ],
    content,
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const md = (e: Editor) => (e.storage as any).markdown.getMarkdown() as string;

describe("searchSlashCommands", () => {
  it("空查询给全表——slash 菜单是发现入口，不是搜索框", () => {
    expect(searchSlashCommands("")).toHaveLength(SLASH_COMMANDS.length);
    expect(searchSlashCommands("   ")).toHaveLength(SLASH_COMMANDS.length);
  });

  it("英文别名前缀命中", () => {
    expect(searchSlashCommands("tab").map(c => c.id)).toContain("table");
    expect(searchSlashCommands("hr").map(c => c.id)).toContain("horizontalRule");
    expect(searchSlashCommands("todo").map(c => c.id)).toContain("taskList");
  });

  it("中文子串命中", () => {
    expect(searchSlashCommands("分栏").map(c => c.id)).toContain("columns");
    expect(searchSlashCommands("标题").map(c => c.id)).toEqual(["h2", "h3"]);
  });

  it("拼音命中（复用成员补全那套 pinyin-pro）", () => {
    expect(searchSlashCommands("fenlan").map(c => c.id)).toContain("columns");
    expect(searchSlashCommands("biaoge").map(c => c.id)).toContain("table");
  });

  it("无匹配返回空——调用侧据此整个不弹弹层", () => {
    expect(searchSlashCommands("zzzz")).toEqual([]);
  });

  it("id 不重复（菜单按 id 做 key，重了会静默丢项）", () => {
    expect(new Set(SLASH_COMMANDS.map(c => c.id)).size).toBe(SLASH_COMMANDS.length);
  });
});

describe("指令落地形态 roundtrip", () => {
  /** 在 "foo" 段落末尾跑指令，返回序列化结果 */
  function runCommand(id: string): string {
    const editor = makeEditor("foo");
    const cmd = SLASH_COMMANDS.find(c => c.id === id)!;
    const end = editor.state.doc.content.size - 1;
    editor.commands.setTextSelection(end);
    cmd.run(editor, { from: end, to: end }); // 空 range=查询串已被用户删净的等价情形
    const out = md(editor);
    editor.destroy();
    return out;
  }

  /** 保真锁纪律：解析 → 再序列化必须逐字复原 */
  function roundtrip(source: string): string {
    const editor = makeEditor(source);
    const out = md(editor);
    editor.destroy();
    return out;
  }

  it.each(SLASH_COMMANDS.map(c => [c.id, c.label]))(
    "%s（%s）落地形态可逐字往返",
    (id) => {
      const produced = runCommand(id as string);
      expect(produced.trim()).not.toBe("");
      expect(roundtrip(produced)).toBe(produced);
    },
  );

  // 反证：证明上面那条 roundtrip 断言不是恒真的。少了这条，把 roundtrip
  // 改成恒过（比如比较前先 trim 掉所有空白）也没人会发现。
  it("反证 —— 非 canonical 形态确实过不了 roundtrip", () => {
    const bad = ":::cols\n左\n---\n右\n:::"; // --- 未被空行包裹 = 不成组
    expect(roundtrip(bad)).not.toBe(bad);
  });

  it("h2 / h3 落标准 ATX 标题", () => {
    expect(runCommand("h2")).toBe("## foo");
    expect(runCommand("h3")).toBe("### foo");
  });

  it("三种列表各落各的标准形态", () => {
    expect(runCommand("bulletList")).toContain("foo");
    expect(runCommand("orderedList")).toMatch(/^1\.\s+foo/);
    expect(runCommand("taskList")).toMatch(/\[ \]\s*foo/);
  });

  it("引用落 blockquote，高亮块落 callout marker（默认 💡、不带 bg）", () => {
    expect(runCommand("blockquote")).toBe("> foo");
    expect(runCommand("callout")).toBe("> [!💡]\n> foo");
  });

  it("分栏落 :::cols fence，栏由空行包裹的 --- 分隔（canonical 无宽度参数）", () => {
    const out = runCommand("columns");
    expect(out).toContain(":::cols");
    expect(out).toContain("\n---\n");
    expect(out.trimEnd().endsWith(":::")).toBe(true);
    // 未指定宽度时不写主参数位——写了 "50,50" 就等于把默认值冻进正文
    expect(out).not.toMatch(/:::cols\s+\d/);
  });

  it("表格落 GFM 管道形态且带表头分隔行", () => {
    const out = runCommand("table");
    expect(out).toContain("|");
    expect(out).toMatch(/\|\s*-+/);
  });

  it("代码块落围栏，分割线落 ---", () => {
    expect(runCommand("codeBlock")).toContain("```");
    expect(runCommand("horizontalRule")).toContain("---");
  });
});
