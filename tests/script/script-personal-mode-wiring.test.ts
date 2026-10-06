import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const editor = readFileSync("components/script/ScriptEditor.tsx", "utf8");
const block = readFileSync("components/script/script-editor/ScriptBlock.tsx", "utf8");

describe("ScriptEditor 个人只读门接线", () => {
  it("权限、个人只读、排练共同收敛为内容写门", () => {
    expect(editor).toContain('const isContentLocked = !baseCanEdit || personalMode === "read" || rehearsalMode;');
    expect(editor).toContain("const baseCanEdit = baseCanEditText || baseCanEditMetadata || baseCanEditTextLayout || canEditRehearsalMark;");
    expect(editor).toContain("const canEditText = baseCanEditText && !isContentLocked;");
    expect(editor).toContain("const canEditMetadata = baseCanEditMetadata && !isContentLocked;");
    expect(editor).toContain("if (!baseCanEditTextLayout || isContentLocked) return;");
  });

  it("普通只读不复用排练版式，拖拽写入口也受编辑门控制", () => {
    expect(editor).toContain("reserveRehearsalGap={rehearsalMode}");
    expect(editor).toContain("readOnlyRehearsalMode={rehearsalMode}");
    expect(block).toContain("draggable={canEditText && !isReorderLocked}");
    expect(block).toContain('canEditText ? "" : "sm:hidden"');
  });

  it("评论和附件面板不叠加个人模式权限，由各自服务端权限继续裁决", () => {
    expect(editor).toContain("<CommentsPanel");
    expect(editor).toContain("<MountPointAssets");
    expect(editor.match(/<CommentsPanel[\s\S]*?\/>/g)?.every((tag) => !tag.includes("isContentLocked"))).toBe(true);
    expect(editor.match(/<MountPointAssets[\s\S]*?\/>/g)?.every((tag) => !tag.includes("isContentLocked"))).toBe(true);
  });
});
