import { describe, it, expect } from "vitest";
import { TOOL_CATALOG, toolRecall, TOOL_RECALL_MAX, DIALECT_CLOSURE_TOOLS } from "@/lib/mcp/tool-catalog";
import { buildMcpServer } from "@/lib/mcp/server";

// #333 P2 工具目录：中文发现面（CJK bigram 召回）+ 与 MCP 注册清单双向防漂移。

describe("tool-catalog 防漂移", () => {
  it("目录与 lib/mcp/server.ts 注册清单一一对应（增删工具必须同批改目录）", async () => {
    const server = buildMcpServer();
    const registered = Object.keys(server["_registeredTools"] as Record<string, unknown>).sort();
    const cataloged = TOOL_CATALOG.map((e) => e.name).sort();
    expect(cataloged).toEqual(registered);
    await server.close();
  });

  it("目录内名字唯一", () => {
    const names = TOOL_CATALOG.map((e) => e.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("方言闭包集合里的名字都在目录里", () => {
    const names = new Set(TOOL_CATALOG.map((e) => e.name));
    for (const n of DIALECT_CLOSURE_TOOLS) expect(names.has(n), n).toBe(true);
  });
});

describe("toolRecall：中文词法召回", () => {
  it("中文短语命中对应工具（官方 tool_search 对中文切空集，这条是我们的发现面）", () => {
    const hits = toolRecall("帮我搜索文档库里关于灯光设计的资料", { hasProduction: true });
    expect(hits.map((h) => h.name)).toContain("production.wiki_search");
  });

  it("通告类消息命中 my.call_times", () => {
    const hits = toolRecall("我明天的通告时间是几点？", { hasProduction: true });
    expect(hits.map((h) => h.name)).toContain("my.call_times");
  });

  it("production 工具在个人会话不提示（推了也只会撞 NO_PRODUCTION）", () => {
    const prod = toolRecall("帮我搜索文档库里的资料", { hasProduction: true });
    expect(prod.map((h) => h.name)).toContain("production.wiki_search");
    const personal = toolRecall("帮我搜索文档库里的资料", { hasProduction: false });
    expect(personal.map((h) => h.name)).not.toContain("production.wiki_search");
  });

  it("personal 工具在个人会话仍可命中", () => {
    const hits = toolRecall("我之前说过的那个决定还记得吗", { hasProduction: false });
    expect(hits.map((h) => h.name)).toContain("my.memory_search");
  });

  it("无关消息不命中（不触发即不注入）", () => {
    expect(toolRecall("今天天气怎么样", { hasProduction: true })).toEqual([]);
  });

  it("命中数量封顶", () => {
    const hits = toolRecall(
      "帮我搜索文档，读文档，修改文档，删除文档，移动文档，新建文档，打标签",
      { hasProduction: true },
    );
    expect(hits.length).toBeLessThanOrEqual(TOOL_RECALL_MAX);
  });

  it("空触发词条目（dialect_ref）永不参与召回", () => {
    const hits = toolRecall("文档的 markdown 方言语法说明", { hasProduction: true });
    expect(hits.map((h) => h.name)).not.toContain("production.wiki_dialect_ref");
  });
});
