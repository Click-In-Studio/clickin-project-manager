import { describe, it, expect } from "vitest";
import { tieredToolNames } from "@/lib/agent-runtime/tool-tiers";
import { TOOL_MCP_NAMES, buildTools } from "@/lib/agent-runtime/tools";
import { TOOL_CATALOG } from "@/lib/agent-tools/tool-catalog";

// #333 三层在 #367 里的实现：每轮工具列表 = 热 ∪ 温(页面) ∪ 召回 ∪ 闭包。

const ALL = TOOL_MCP_NAMES;

describe("tool tiers", () => {
  it("个人会话：热层只有 my.* + ask_user，production 工具一律不出现", () => {
    const r = tieredToolNames({ hasProduction: false, pageKey: null, prompt: "你好", available: ALL });
    expect(r.active).toContain("my.productions");
    expect(r.active).toContain("ask_user");
    expect(r.active).toContain("web.search"); // 联网是基础能力，个人/制作会话都常驻
    expect(r.active).toContain("web.fetch");
    expect(r.active.some((n) => n.startsWith("production."))).toBe(false);
  });

  it("制作会话首页：热层含范围锚点与 id 供给入口，不含 wiki 族", () => {
    const r = tieredToolNames({ hasProduction: true, pageKey: "prod:home", prompt: "你好", available: ALL });
    for (const n of ["my.productions", "production.info", "production.my_role", "production.contact_list", "production.department_list"]) {
      expect(r.active, n).toContain(n);
    }
    expect(r.active.some((n) => n.startsWith("production.wiki_"))).toBe(false);
  });

  it("文档库页面：温层带出整个 wiki 族（含 dialect_ref 与 set_grant 闭包的 id 供给）", () => {
    const r = tieredToolNames({ hasProduction: true, pageKey: "prod:wiki", prompt: "你好", available: ALL });
    expect(r.warm).toContain("production.wiki_propose_update");
    expect(r.active).toContain("production.wiki_dialect_ref");
    expect(r.active).toContain("production.wiki_set_grant");
  });

  it("非文档页面但中文消息命中 wiki 工具 → 召回带出它及闭包（tree/search/read/dialect_ref）", () => {
    const r = tieredToolNames({ hasProduction: true, pageKey: "prod:home", prompt: "帮我修改文档，把会议结论补充进去", available: ALL });
    expect(r.recalled).toContain("production.wiki_propose_update");
    for (const n of ["production.wiki_tree", "production.wiki_search", "production.wiki_read", "production.wiki_dialect_ref"]) {
      expect(r.active, n).toContain(n);
    }
  });

  it("构作页：温层带出整个构作族；剧本页只带读面 + 权限查询", () => {
    const r = tieredToolNames({ hasProduction: true, pageKey: "prod:dramaturgy", prompt: "你好", available: ALL });
    for (const n of ["production.dramaturgy_permissions", "production.scene_list", "production.scene_propose_update", "production.character_propose_delete"]) {
      expect(r.warm, n).toContain(n);
    }
    const s = tieredToolNames({ hasProduction: true, pageKey: "prod:script", prompt: "你好", available: ALL });
    expect(s.active).toContain("production.scene_list");
    expect(s.active).toContain("production.dramaturgy_permissions");
    expect(s.active).not.toContain("production.scene_propose_update");
  });

  it("首页说「帮我给第二场改梗概」→ 召回构作族，闭包补上权限查询与 id 供给", () => {
    const r = tieredToolNames({ hasProduction: true, pageKey: "prod:home", prompt: "帮我把第二场的梗概改一下", available: ALL });
    expect(r.recalled).toContain("production.scene_propose_update");
    for (const n of ["production.dramaturgy_permissions", "production.scene_list", "production.scene_read"]) expect(r.active, n).toContain(n);
  });

  it("冷层工具没有页面也没有触发词 → 不出现（set_grant 在首页闲聊时不可见）", () => {
    const r = tieredToolNames({ hasProduction: true, pageKey: "prod:home", prompt: "今天天气怎么样", available: ALL });
    expect(r.active).not.toContain("production.wiki_set_grant");
    expect(r.active).not.toContain("production.update_instructions");
  });

  it("AGENT_TOOL_TIERS=off → 全量", () => {
    const prev = process.env.AGENT_TOOL_TIERS;
    process.env.AGENT_TOOL_TIERS = "off";
    try {
      const r = tieredToolNames({ hasProduction: false, pageKey: null, prompt: null, available: ALL });
      expect(r.active.length).toBe(ALL.length);
    } finally {
      if (prev === undefined) delete process.env.AGENT_TOOL_TIERS; else process.env.AGENT_TOOL_TIERS = prev;
    }
  });

  it("注册表 ⊇ 目录（tool-catalog 是 MCP 面的清单；运行时额外有 ask_user）", () => {
    const registry = new Set(ALL);
    for (const e of TOOL_CATALOG) expect(registry.has(e.name), e.name).toBe(true);
    expect(registry.has("ask_user")).toBe(true);
  });

  it("安全不变量：工具 schema 里不允许出现身份/语境字段（身份只来自请求上下文）", () => {
    const forbidden = /^(_caller_user_id|_caller_production_id|_tool_call_id|userId|productionId|user_id|production_id)$/;
    for (const t of buildTools({ userId: "u", productionId: "p" })) {
      const props = ((t.parameters as { properties?: Record<string, unknown> }).properties ?? {});
      for (const key of Object.keys(props)) expect(forbidden.test(key), `${t.name}.${key}`).toBe(false);
    }
  });
});

describe("tool tiers：正向闭包与会话内已用工具", () => {
  it("召回是族粒度：调用方传整族名字（通讯录页）→ 整族入面，跨族依赖仍由闭包补（set_grant → contact/department）", () => {
    const wiki = TOOL_CATALOG.filter((e) => e.family === "production.wiki").map((e) => e.name);
    const r = tieredToolNames({ hasProduction: true, pageKey: "prod:home", prompt: null, recalled: wiki, available: ALL });
    for (const n of wiki) expect(r.active, n).toContain(n);
    expect(r.active).toContain("production.contact_list");
  });

  it("本会话早前调过的工具留在面上（used），即使这轮页面/召回都不带它", () => {
    const without = tieredToolNames({ hasProduction: true, pageKey: "prod:contacts", prompt: "这次你的工具列表里有 read 了吗", recalled: [], available: ALL });
    expect(without.active).not.toContain("production.wiki_read");
    const withUsed = tieredToolNames({ hasProduction: true, pageKey: "prod:contacts", prompt: "这次你的工具列表里有 read 了吗", recalled: [], used: ["production.wiki_read"], available: ALL });
    expect(withUsed.active).toContain("production.wiki_read");
  });
});
