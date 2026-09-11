import { describe, it, expect } from "vitest";
import { TOOL_LABELS, toolLabel } from "@/lib/agent-tool-labels";
import { TOOL_MCP_NAMES } from "@/lib/agent-runtime/tools";
import { boundPayload } from "@/lib/agent-runtime/stream-lines";

// 翻译表防漂移：对照运行时注册表（lib/agent-runtime/tools.ts）——新增工具没配中文
// 显示名、或表里留着已退役工具的残条，这里会红。

function registeredToolNames(): string[] {
  return [...TOOL_MCP_NAMES];
}

describe("agent tool labels", () => {
  const names = registeredToolNames();

  it("扫描到了全部注册工具（清单非空、量级正确）", () => {
    expect(names.length).toBeGreaterThanOrEqual(20);
  });

  it("每个注册工具都有中文显示名", () => {
    const missing = names.filter((n) => {
      const bare = n.replace(/\./g, "-");
      return !(bare in TOOL_LABELS);
    });
    expect(missing).toEqual([]);
  });

  it("翻译表没有已退役工具的残条", () => {
    const bareNames = new Set(names.map((n) => n.replace(/\./g, "-")));
    const stale = Object.keys(TOOL_LABELS).filter((k) => !bareNames.has(k));
    expect(stale).toEqual([]);
  });

  it("toolLabel 对暴露名/原始名/未知名都给出合理显示", () => {
    expect(toolLabel("clickin__production-wiki_read")).toBe("阅读文档");
    expect(toolLabel("production.wiki_read")).toBe("阅读文档");
    expect(toolLabel("clickin__future-tool")).toBe("future-tool"); // 未配置 → 去前缀原名
    expect(toolLabel("exec")).toBe("exec");
  });
});

describe("boundPayload（工具参数/结果透传大小闸）", () => {
  it("小 payload 原样透传，null/undefined 归一为 undefined", () => {
    expect(boundPayload({ wikiId: "w1" })).toEqual({ wikiId: "w1" });
    expect(boundPayload("文本")).toBe("文本");
    expect(boundPayload(null)).toBeUndefined();
    expect(boundPayload(undefined)).toBeUndefined();
  });

  it("超限 payload 退化为截断预览包裹", () => {
    const big = { text: "长".repeat(20_000) };
    const out = boundPayload(big) as { truncated: boolean; preview: string };
    expect(out.truncated).toBe(true);
    expect(out.preview.length).toBeLessThanOrEqual(16_000);
  });

  it("不可序列化的 payload 丢弃而非抛错", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(boundPayload(cyclic)).toBeUndefined();
  });
});
