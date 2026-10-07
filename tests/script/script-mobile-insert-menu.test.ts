import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const editor = readFileSync(path.join(process.cwd(), "components/script/ScriptEditor.tsx"), "utf8");
const insertZone = readFileSync(path.join(process.cwd(), "components/script/script-editor/InsertZone.tsx"), "utf8");

describe("手机端剧本块新增入口", () => {
  it("小于 sm 时连同插入占位一起隐藏，sm 起保留桌面快捷入口", () => {
    expect(insertZone).toContain('className="group hidden h-5 items-center justify-center px-6 sm:flex"');
    expect(insertZone).toContain('title="插入新块"');
  });

  it("块菜单复用 insertBlockAt，并保留章、段和排练记号入口", () => {
    const newBlock = editor.indexOf('label: "添加新剧本块"');
    const newChapter = editor.indexOf('label: "添加新章"', newBlock);
    const newScene = editor.indexOf('label: "添加新段"', newChapter);
    const newRehearsal = editor.indexOf('label: "添加新排练记号"', newScene);
    expect(newBlock).toBeGreaterThan(-1);
    expect(editor.slice(newBlock, newChapter)).toContain("insertBlockAt(menuBlockIndex)");
    expect(newChapter).toBeGreaterThan(newBlock);
    expect(newScene).toBeGreaterThan(newChapter);
    expect(newRehearsal).toBeGreaterThan(newScene);
  });

  it("无文本编辑权限或排练锁定时保持菜单项但禁止执行，并说明原因", () => {
    expect(editor).toContain("if (!canEditText) return;");
    expect(editor).toContain('"排练模式下不可添加"');
    expect(editor).toContain('"只读模式下不可添加"');
    expect(editor).toContain('"需要剧本文本编辑权限"');
    expect(editor).toContain("aria-disabled={!!disabledReason}");
    expect(editor).toContain("if (!disabledReason) runAndClose(action)");
  });

  it("插入仍经过撤销快照、结构保存、标签继承和新块聚焦链路", () => {
    const start = editor.indexOf("const insertBlockAt = useCallback");
    const end = editor.indexOf("const addChar", start);
    const insertion = editor.slice(start, end);
    expect(insertion).toContain("saveSnapshot()");
    expect(insertion).toContain("pendingCharOpen.current = newBlock.id");
    expect(insertion).toContain("applyBlockStructureEdit(previousBlocks, updated");
    expect(insertion).toContain("inheritTags(refId, newBlockId)");
  });
});
