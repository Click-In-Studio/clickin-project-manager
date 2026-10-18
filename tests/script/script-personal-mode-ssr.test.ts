import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DEFAULT_SCRIPT_CONFIG, type Block } from "@/lib/script/script-types";
import ScriptEditor from "@/components/script/ScriptEditor";

// localStorage 只能挂载后读取，真实剧本页的 SSR 首帧须保持只读。
describe("剧本模式 SSR", () => {
  it("无 window 时能渲染正文，且首帧使用只读版式并锁定输入", () => {
    expect(typeof window).toBe("undefined");
    const block: Block = {
      id: "ssr-line", type: "dialogue", content: "排练台词", lyric: false,
      characterIds: [], characterAnnotations: {}, sceneId: null, rehearsalMark: null,
    };
    const html = renderToString(createElement(ScriptEditor, {
      productionId: "ssr-script",
      initialWindow: {
        versionId: "ssr-head", orderRevision: "0", manifest: [block],
        window: { start: 0, blocks: [block], tags: [] }, scenes: [], characters: [],
        config: DEFAULT_SCRIPT_CONFIG, tagGroups: [], pageMap: {},
      },
    }));
    expect(html).toContain('data-block-content="ssr-line"');
    expect(html).toContain('contentEditable="false"');
    expect(html).not.toContain('contentEditable="true"');
    expect(html).toContain("text-zinc-300 group-hover:text-zinc-500");
  });
});
