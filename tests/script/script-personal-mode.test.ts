// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";
import { readScriptPersonalMode, writeScriptPersonalMode } from "@/components/script/script-editor/personal-mode";

describe("剧本个人编辑 / 只读模式存储", () => {
  beforeEach(() => localStorage.clear());

  it("默认编辑，并按剧本分别记忆", () => {
    expect(readScriptPersonalMode("script-a")).toBe("edit");
    writeScriptPersonalMode("script-a", "read");
    expect(readScriptPersonalMode("script-a")).toBe("read");
    expect(readScriptPersonalMode("script-b")).toBe("edit");
  });

  it("异常旧值不会放大为编辑以外的新状态", () => {
    localStorage.setItem("clickin:script-personal-mode:script-a", "unexpected");
    expect(readScriptPersonalMode("script-a")).toBe("edit");
  });
});
