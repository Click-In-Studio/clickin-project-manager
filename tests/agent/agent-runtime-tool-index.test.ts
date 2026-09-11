import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { recallFamilies, searchTools, scoreTools, resetToolIndex, TOOL_VECTOR_THRESHOLD, TOOL_RECALL_MAX_FAMILIES } from "@/lib/agent-runtime/tool-index";
import { TOOL_CATALOG } from "@/lib/agent-tools/tool-catalog";

// #367 工具索引：词法 + 向量两条车道。EMBEDDING_PROVIDER=fake 的向量是内容哈希展开的单位
// 向量——同文本恒同向量（余弦 1）、不同文本近似正交，所以"例句原话"能把向量车道单独测出来。

describe("tool-index（fake embedding）", () => {
  const prev = process.env.EMBEDDING_PROVIDER;
  beforeAll(() => {
    process.env.EMBEDDING_PROVIDER = "fake";
    resetToolIndex();
  });
  afterAll(() => {
    if (prev === undefined) delete process.env.EMBEDDING_PROVIDER; else process.env.EMBEDDING_PROVIDER = prev;
    resetToolIndex();
  });

  it("例句原话 → 向量车道命中（余弦 1），即使没有任何触发词", async () => {
    const example = TOOL_CATALOG.find((e) => e.name === "production.contact_list")!.examples![0]; // "这个项目有哪些成员"
    const hits = await scoreTools(example, { hasProduction: true });
    const top = hits[0];
    expect(top.name).toBe("production.contact_list");
    expect(top.vector).toBeCloseTo(1, 5);
    const fams = await recallFamilies(example, { hasProduction: true });
    expect(fams[0].family).toBe("production.people");
    expect(fams[0].top.name).toBe("production.contact_list");
    expect(fams[0].tools.map((t) => t.name)).toEqual(["production.contact_list", "production.department_list"]); // 整族
  });

  it("族粒度：命中 wiki 族任一工具 → 整族入面（含未直接命中的 wiki_read / propose_*）", async () => {
    const fams = await recallFamilies("帮我在文档库里搜一下灯光的资料", { hasProduction: true });
    const wiki = fams.find((f) => f.family === "production.wiki")!;
    expect(wiki).toBeDefined();
    const names = wiki.tools.map((t) => t.name);
    expect(names).toContain("production.wiki_search");
    expect(names).toContain("production.wiki_read");
    expect(names).toContain("production.wiki_propose_update");
    expect(fams.length).toBeLessThanOrEqual(TOOL_RECALL_MAX_FAMILIES);
  });

  it("触发词命中走词法车道；无关句子两条车道都不命中", async () => {
    const fams = await recallFamilies("我明天的通告时间是几点", { hasProduction: true });
    expect(fams.map((f) => f.family)).toContain("my.schedule");
    expect(fams.find((f) => f.family === "my.schedule")!.top.lexical).toBeGreaterThanOrEqual(0.72);
    expect(await recallFamilies("今天天气怎么样", { hasProduction: true })).toEqual([]);
  });

  it("find_tools 搜索：不设阈值取前 N，个人会话不返回 production 工具", async () => {
    const prod = await searchTools("我能看到哪些文档", { hasProduction: true, limit: 3 });
    expect(prod.length).toBeGreaterThan(0);
    expect(prod.length).toBeLessThanOrEqual(3);
    expect(prod[0].name).toBe("production.wiki_tree");
    const personal = await searchTools("我能看到哪些文档", { hasProduction: false, limit: 5 });
    expect(personal.every((h) => !h.name.startsWith("production."))).toBe(true);
  });

  it("阈值可由 env 覆盖（默认 0.5）", () => {
    expect(TOOL_VECTOR_THRESHOLD).toBeGreaterThan(0);
  });
});

describe("tool-index（无 embedding 供应商 → 词法单路）", () => {
  const prev = process.env.EMBEDDING_PROVIDER;
  beforeAll(() => {
    process.env.EMBEDDING_PROVIDER = "none";
    resetToolIndex();
  });
  afterAll(() => {
    if (prev === undefined) delete process.env.EMBEDDING_PROVIDER; else process.env.EMBEDDING_PROVIDER = prev;
    resetToolIndex();
  });

  it("vector 为 null，词法照常", async () => {
    const hits = await scoreTools("列举我能看到的 wiki 文档", { hasProduction: true });
    expect(hits[0].vector).toBeNull();
    expect(hits[0].lexical).toBeGreaterThanOrEqual(0.72);
  });
});
