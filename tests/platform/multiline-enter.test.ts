import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isMultilineSubmitShortcut } from "@/components/ui/multiline-keyboard";

describe("#730 多行输入的换行与提交", () => {
  it("普通 Enter 保留给换行，只有非输入法组合态的 Mod+Enter 提交", () => {
    expect(isMultilineSubmitShortcut({ key: "Enter", metaKey: false, ctrlKey: false })).toBe(false);
    expect(isMultilineSubmitShortcut({ key: "Enter", metaKey: true, ctrlKey: false })).toBe(true);
    expect(isMultilineSubmitShortcut({ key: "Enter", metaKey: false, ctrlKey: true })).toBe(true);
    expect(isMultilineSubmitShortcut({ key: "Enter", metaKey: true, ctrlKey: false, isComposing: true })).toBe(false);
    expect(isMultilineSubmitShortcut({
      key: "Enter",
      metaKey: false,
      ctrlKey: true,
      nativeEvent: { isComposing: true },
    })).toBe(false);
    expect(isMultilineSubmitShortcut({ key: "a", metaKey: true, ctrlKey: false })).toBe(false);
  });

  it("所有带提交动作的多行工作面消费同一快捷键规则", () => {
    const files = [
      "components/agent/AgentPopout.tsx",
      "components/ops/ReportViewClient.tsx",
      "components/ops/event-detail/DeptNotesList.tsx",
      "components/ops/cue-page/CueCommentsPanel.tsx",
      "components/script/SceneTableView.tsx",
      "components/script/CharactersManager.tsx",
      "components/script/script-editor/BlockStageComment.tsx",
      "components/script/script-editor/CommentsPanel.tsx",
    ];

    for (const file of files) {
      expect(readFileSync(file, "utf8"), file).toContain("isMultilineSubmitShortcut");
    }
  });

  it("富文本多行面提示软键盘 Enter 为换行，剧本正文仍保留结构化 Enter", () => {
    const smartTextarea = readFileSync("components/editor/SmartTextarea.tsx", "utf8");
    const scriptBlock = readFileSync("components/script/script-editor/ScriptBlock.tsx", "utf8");

    expect(smartTextarea).toContain('enterkeyhint: "enter"');
    expect(scriptBlock).toContain('if (e.key === "Enter" && !e.shiftKey)');
    expect(scriptBlock).toContain('if (e.key === "Enter" && e.shiftKey)');
  });
});
