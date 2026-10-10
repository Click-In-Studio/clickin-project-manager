import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const editor = readFileSync("components/script/ScriptEditor.tsx", "utf8");
const block = readFileSync("components/script/script-editor/ScriptBlock.tsx", "utf8");
const page = readFileSync("app/production/[id]/script/page.tsx", "utf8");

describe("ScriptEditor 个人只读门接线", () => {
  it("权限、个人只读、排练共同收敛为内容写门", () => {
    expect(editor).toContain('const isContentLocked = recoveryLocked || !personalModeReady || !baseCanEdit || personalMode === "read" || rehearsalMode;');
    expect(editor).toContain("const baseCanEdit = baseCanEditText || baseCanEditMetadata || baseCanEditTextLayout || canEditRehearsalMark;");
    expect(editor).toContain("const canEditText = baseCanEditText && !isContentLocked;");
    expect(editor).toContain("const canEditMetadata = baseCanEditMetadata && !isContentLocked;");
    expect(editor).toContain("if (!baseCanEditTextLayout || isContentLocked) return;");
  });

  it("服务端首帧不读取 localStorage，挂载后才恢复当前剧本的个人模式", () => {
    expect(editor).toContain("useStoredScriptPersonalMode(effectiveScriptId)");
    expect(editor).toContain("personalModeReady && baseCanEdit ? personalMode : \"read\"");
    expect(editor).not.toContain("useState<ScriptPersonalMode>(() => readScriptPersonalMode");
  });

  it("排练与显示 cookie 由服务端解析后作为同一份首帧初值下发", () => {
    expect(page).toContain("initialDisplay={parseDisplayCookie(cookieStore.get(DISPLAY_COOKIE)?.value)}");
    expect(editor).toContain("useState(initialDisplay.rehearsalMode)");
    expect(editor).toContain("useDisplaySettings({ maxLineIndexText, initialDisplay })");
    expect(editor).not.toContain("readDisplayCookie().rehearsalMode");
  });

  it("切只读时持续冲刷保存期间的新输入，不能只验证请求前的旧快照", () => {
    expect(editor).toContain("const flushPendingPatch = sync.flush;");
    expect(editor).toContain("flushPendingPatchRef.current = flushPendingPatch");
    expect(editor).toContain("useScriptSync(script, {");
  });

  it("从编辑进入排练前也必须冲刷待保存内容，失败时保持原模式", () => {
    expect(editor).toContain('pendingRehearsalMode && personalMode === "edit" && !await flushPendingPatchRef.current()');
    expect(editor).toContain('setRehearsalModeSwitchError("尚有内容未保存，已保留编辑模式，请稍后重试。")');
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
