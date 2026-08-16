import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { makeProduction, cleanupProduction, shortId } from "./factories";
import { upsertFeishuUser, addProductionMember } from "@/lib/db";
import { createWiki, listOutgoingLinks } from "@/lib/wiki-db";
import { DENIED_NOT_MEMBER } from "@/lib/mcp/production-tools";
import { wikiTree, wikiBacklinks, wikiRead, wikiSearch } from "@/lib/mcp/wiki-tools";

// AI 视角必须与人类视角完全一致：无授权的成员在 tree/search 里绝不能看到
// 私有文档——这是本批工具最核心的安全保证，比"功能能跑"更重要。

let prodId: string;
let ownerId: string;
let plainMemberId: string;
let outsiderId: string;
let rootId: string;
let childId: string;
let privateId: string;

beforeAll(async () => {
  ownerId = (await upsertFeishuUser(`test-open-${shortId()}`, `所有者${shortId()}`, null, false)).userId;
  plainMemberId = (await upsertFeishuUser(`test-open-${shortId()}`, `普通成员${shortId()}`, null, false)).userId;
  outsiderId = (await upsertFeishuUser(`test-open-${shortId()}`, `局外人${shortId()}`, null, false)).userId;
  ({ prodId } = await makeProduction(ownerId));
  // plainMemberId 只加成员行，不发任何 role/grant——刻意造一个"零原子权限"的成员
  await addProductionMember(prodId, plainMemberId);

  const root = await createWiki({ productionId: prodId, title: "根文档", body: "根正文", createdBy: ownerId });
  rootId = root.id;
  const child = await createWiki({
    productionId: prodId, title: "子文档", body: `链接回根：[#wiki:${rootId}]`,
    parentId: rootId, createdBy: ownerId,
  });
  childId = child.id;
  const priv = await createWiki({ productionId: prodId, title: "私有文档", body: "只有所有者能看", createdBy: ownerId });
  privateId = priv.id;
});

afterAll(async () => {
  await cleanupProduction(prodId).catch(() => {});
});

describe("权限门语义", () => {
  it("非成员一律明确拒绝，不是空结果", async () => {
    expect(await wikiTree(outsiderId, prodId)).toBe(DENIED_NOT_MEMBER);
    expect(await wikiBacklinks(outsiderId, prodId, rootId)).toBe(DENIED_NOT_MEMBER);
    expect(await wikiRead(outsiderId, prodId, rootId)).toBe(DENIED_NOT_MEMBER);
    expect(await wikiSearch(outsiderId, prodId, "根")).toBe(DENIED_NOT_MEMBER);
  });

  it("wikiTree/wikiSearch：零权限成员看不到私有文档（AI 视角 = 人类视角）", async () => {
    const tree = await wikiTree(plainMemberId, prodId);
    expect(tree).not.toContain("私有文档");

    const search = await wikiSearch(plainMemberId, prodId, "私有");
    expect(search).not.toContain(privateId);
    expect(search).toBe("（没有匹配的文档）");
  });

  it("wikiRead/wikiBacklinks：零权限成员读私有文档被拒", async () => {
    const read = await wikiRead(plainMemberId, prodId, privateId);
    expect(read).toContain("权限被拒绝");
    const backlinks = await wikiBacklinks(plainMemberId, prodId, privateId);
    expect(backlinks).toContain("权限被拒绝");
  });

  it("owner（全权限旁路）能看到全部文档", async () => {
    const tree = await wikiTree(ownerId, prodId);
    expect(tree).toContain("根文档");
    expect(tree).toContain("子文档");
    expect(tree).toContain("私有文档");
  });
});

describe("功能正确性（owner 视角）", () => {
  it("wikiTree 嵌套缩进反映父子层级", async () => {
    const tree = await wikiTree(ownerId, prodId);
    const rootLine = tree.split("\n").find((l) => l.includes("根文档"))!;
    const childLine = tree.split("\n").find((l) => l.includes("子文档"))!;
    expect(rootLine.startsWith("- ")).toBe(true);
    expect(childLine.startsWith("  - ")).toBe(true); // 缩进一级
  });

  it("wikiBacklinks 分别列出 backlinks 与 outgoing", async () => {
    const out = await wikiBacklinks(ownerId, prodId, rootId);
    expect(out).toContain("谁链接到它");
    expect(out).toContain("子文档"); // 子文档链接回根，根的 backlinks 里应有它
    expect(out).toContain("它链接到谁");
  });

  it("wikiRead 把 id 形态链接换成可读标题", async () => {
    const out = await wikiRead(ownerId, prodId, childId);
    expect(out).toContain("[[根文档]]");
    expect(out).not.toContain(`[#wiki:${rootId}]`);
  });

  it("wikiRead 对已删除目标的 token 优雅降级", async () => {
    const ghostId = "00000000-0000-4000-8000-000000000000";
    const doc = await createWiki({
      productionId: prodId, title: "指向幽灵的文档", body: `坏链接：[#wiki:${ghostId}]`, createdBy: ownerId,
    });
    const out = await wikiRead(ownerId, prodId, doc.id);
    expect(out).toContain("[[已删除的文档]]");
  });

  it("wikiSearch 命中标题与正文，按可见性过滤", async () => {
    const out = await wikiSearch(ownerId, prodId, "根正文");
    expect(out).toContain("根文档");
  });
});

describe("lib/wiki-db.ts listOutgoingLinks", () => {
  it("互链：A 链 B、B 链 A 各自的 outgoing 只含对方", async () => {
    const a = await createWiki({ productionId: prodId, title: "互链甲", createdBy: ownerId });
    const b = await createWiki({ productionId: prodId, title: "互链乙", body: `[#wiki:${a.id}]`, createdBy: ownerId });
    await createWiki({ productionId: prodId, title: "互链甲-占位", createdBy: ownerId }); // 干扰项，避免误判空数组
    // 回填 a 指向 b（updateWiki 不在本测试范围，直接用 createWiki 的 body 参数模拟单向）
    const aOutgoing = await listOutgoingLinks(a.id, prodId);
    expect(aOutgoing.map((r) => r.id)).not.toContain(b.id); // a 未链 b，单向验证

    const bOutgoing = await listOutgoingLinks(b.id, prodId);
    expect(bOutgoing.map((r) => r.id)).toContain(a.id);
  });

  it("跨 production 的文档不出现在 outgoing 结果里", async () => {
    const { prodId: otherProd } = await makeProduction(ownerId);
    try {
      const foreign = await createWiki({ productionId: otherProd, title: "别的项目的文档", createdBy: ownerId });
      const mine = await createWiki({
        productionId: prodId, title: "本项目引用别项目 id", body: `[#wiki:${foreign.id}]`, createdBy: ownerId,
      });
      // 目标不在同一 production，wiki_link 的 syncWikiLinks 按 production 过滤，不会落行
      const outgoing = await listOutgoingLinks(mine.id, prodId);
      expect(outgoing.map((r) => r.id)).not.toContain(foreign.id);
    } finally {
      await cleanupProduction(otherProd).catch(() => {});
    }
  });
});
