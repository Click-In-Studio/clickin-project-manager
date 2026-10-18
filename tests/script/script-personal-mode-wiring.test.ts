import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const editor = readFileSync("components/script/ScriptEditor.tsx", "utf8");
const block = readFileSync("components/script/script-editor/ScriptBlock.tsx", "utf8");
const page = readFileSync("app/production/[id]/script/page.tsx", "utf8");

describe("ScriptEditor 个人只读门接线", () => {
  it("权限与个人模式共同决定唯一只读状态与内容写门", () => {
    expect(editor).toContain('const isContentLocked = recoveryLocked || !personalModeReady || isReadMode;');
    expect(editor).toContain('const isReadMode = effectivePersonalMode === "read";');
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

  it("模式仅由按剧本 localStorage 恢复，旧排练 cookie 不再驱动模式", () => {
    expect(page).toContain("initialDisplay={parseDisplayCookie(cookieStore.get(DISPLAY_COOKIE)?.value)}");
    expect(editor).not.toMatch(/rehearsalMode|setRehearsalMode|pendingRehearsalMode/);
    expect(editor).toContain("selectedMode={effectivePersonalMode}");
    expect(existsSync("components/script/script-editor/RehearsalModeDialog.tsx")).toBe(false);
  });

  it("切换前冲刷未保存内容，并在只读版式切换后恢复滚动锚点", () => {
    expect(editor).toContain("const flushPendingPatch = sync.flush;");
    expect(editor).toContain("useScriptSync(script, {");
    expect(editor).toContain("captureScrollAnchor: captureVirtualScrollAnchor");
    expect(editor).toContain("preserveScrollAnchor: (anchor) => { pendingModeScrollAnchorRef.current = anchor; }");
    expect(editor).toContain("[isReadMode, scriptConfig.textLayoutMode, restoreVirtualScrollAnchor]");
  });

  it("只读完整沿用排练版式，拖拽仍受编辑门控制", () => {
    expect(editor).toContain("reserveRehearsalGap={isReadMode}");
    expect(editor).toContain("readOnlyMode={isReadMode}");
    expect(editor).toContain("isReadMode && shouldShowSceneEndGap(prev, block)");
    expect(editor).toContain("isReadMode && shouldShowCharacterGap(");
    expect(editor).toContain("readOnlyScene={isReadMode && display.rehearsalBlockScenes");
    expect(editor).toContain("const maxVisibleAvatars = isReadMode");
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
