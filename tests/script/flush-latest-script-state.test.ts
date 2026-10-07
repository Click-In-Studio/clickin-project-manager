import { describe, expect, it, vi } from "vitest";
import { flushLatestScriptState } from "@/components/script/script-editor/flush-latest-script-state";
import { DEFAULT_SCRIPT_CONFIG, type ScriptState } from "@/lib/script/script-types";

function state(content: string): ScriptState {
  return {
    config: DEFAULT_SCRIPT_CONFIG,
    blocks: [{
      id: "block-a",
      type: "dialogue",
      content,
      characterIds: [],
      characterAnnotations: {},
      lyric: false,
      sceneId: null,
      rehearsalMark: null,
    }],
    characters: [],
    scenes: [],
  };
}

describe("个人模式切换前冲刷最新剧本状态", () => {
  it("首笔保存飞行期间继续输入时，再保存一次最新内容后才完成", async () => {
    let current = state("第一笔");
    let synced = state("");
    const push = vi.fn(async (snapshot: ScriptState) => {
      if (push.mock.calls.length === 1) current = state("保存期间的新输入");
      synced = snapshot;
      return true;
    });

    await expect(flushLatestScriptState(
      () => current,
      push,
      (latest) => latest.blocks[0].content === synced.blocks[0].content,
    )).resolves.toBe(true);

    expect(push).toHaveBeenCalledTimes(2);
    expect(synced.blocks[0].content).toBe("保存期间的新输入");
  });

  it("任一保存失败就保留编辑模式，不继续空转", async () => {
    const push = vi.fn().mockResolvedValue(false);
    await expect(flushLatestScriptState(
      () => state("未保存"),
      push,
      () => false,
    )).resolves.toBe(false);
    expect(push).toHaveBeenCalledOnce();
  });
});
