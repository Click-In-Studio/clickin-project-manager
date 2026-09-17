import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { getPool } from "@/lib/pg";
import { createSession, SESSION_COOKIE } from "@/lib/account/session";
import { createWiki, duplicateWiki, duplicateTitle, getWiki, updateWiki } from "@/lib/wiki/content";
import { getNodeByWikiId, listNodeLibrary, setNodeListable, setNodePublic } from "@/lib/node/db";
import { WIKI_LEVEL_ROW_SETS } from "@/lib/perm/resource-grant-db";
import { POST as duplicatePOST } from "@/app/api/production/[id]/wiki/[wikiId]/duplicate/route";
import { makeProduction, cleanupProduction } from "../_support/factories";

// #511 创建副本。抄的是内容（正文/标签/提及），不抄的是别人对原件的引用与分享；
// 落位＝原件紧后、同父、同可枚举位。路由三门：读原件 ∧ create ∧ 落位双门。

async function newMember(prodId: string): Promise<string> {
  const { rows } = await getPool().query<{ id: string }>("INSERT INTO app_user DEFAULT VALUES RETURNING id");
  await getPool().query(
    `INSERT INTO production_member (production_id, user_id, roles) VALUES ($1, $2, '{}')`, [prodId, rows[0].id]);
  return rows[0].id;
}
async function grantCreate(prodId: string, userId: string) {
  await getPool().query(
    `INSERT INTO production_member_grant
       (production_id, user_id, resource_type, resource_id, resource_sub, permission_level, grant_source, confirmed_by)
     VALUES ($1, $2, 'wiki', '*', '*', 'create', 'direct', $2) ON CONFLICT DO NOTHING`, [prodId, userId]);
}
async function shareView(prodId: string, wikiId: string, userId: string) {
  for (const [sub, verb] of WIKI_LEVEL_ROW_SETS.view) {
    await getPool().query(
      `INSERT INTO production_member_grant
         (production_id, user_id, resource_type, resource_id, resource_sub, permission_level, grant_source, confirmed_by)
       VALUES ($1, $2, 'wiki', $3, $4, $5, 'direct', $2)`, [prodId, userId, wikiId, sub, verb]);
  }
}
const cookieFor = (userId: string) =>
  `${SESSION_COOKIE}=${createSession({ userId, name: "测试", avatarUrl: null, isAdmin: false })}`;
const req = (prodId: string, wikiId: string, userId: string) => new NextRequest(
  `http://localhost/api/production/${prodId}/wiki/${wikiId}/duplicate`,
  { method: "POST", headers: { Cookie: cookieFor(userId) } });
const ctx = (prodId: string, wikiId: string) => ({ params: Promise.resolve({ id: prodId, wikiId }) });

let prodId: string;
let creator: string;
let stranger: string;
let builder: string;
const users: string[] = [];

beforeAll(async () => {
  ({ prodId } = await makeProduction());
  creator = await newMember(prodId);
  stranger = await newMember(prodId);   // 无 create、无分享
  builder = await newMember(prodId);    // 有 create、原件只被分享 view
  await grantCreate(prodId, creator);
  await grantCreate(prodId, builder);
  users.push(creator, stranger, builder);
});

afterAll(async () => {
  await cleanupProduction(prodId).catch(() => {});
  await getPool().query("DELETE FROM app_user WHERE id = ANY($1)", [users]).catch(() => {});
});

describe("duplicateTitle", () => {
  it("首次加「 副本」，再复制递增，无标题回落", () => {
    expect(duplicateTitle("排练计划")).toBe("排练计划 副本");
    expect(duplicateTitle("排练计划 副本")).toBe("排练计划 副本 2");
    expect(duplicateTitle("排练计划 副本 2")).toBe("排练计划 副本 3");
    expect(duplicateTitle(null)).toBe("无标题 副本");
    expect(duplicateTitle("  ")).toBe("无标题 副本");
  });
});

describe("duplicateWiki（lib）", () => {
  it("正文/标签/提及照抄；落原件紧后、同父、同可枚举位；分享行集不抄", async () => {
    const parent = await createWiki({ productionId: prodId, title: "父", createdBy: creator });
    const src = await createWiki({
      productionId: prodId, title: "原件", body: "正文 [[父]]", parentNodeId: parent.nodeId, createdBy: creator,
    });
    const after = await createWiki({ productionId: prodId, title: "后一个", parentNodeId: parent.nodeId, createdBy: creator });
    await updateWiki(src.id, prodId, {
      tags: ["甲", "乙"], mentions: [{ type: "user", id: creator } as never],
    }, creator);
    await setNodeListable(src.nodeId, prodId, false);
    await setNodePublic(src.nodeId, prodId, true);
    await shareView(prodId, src.id, stranger);

    const copy = (await duplicateWiki(src.id, prodId, builder))!;
    expect(copy.title).toBe("原件 副本");
    expect(copy.body).toBe("正文 [[父]]");
    expect([...copy.tags].sort()).toEqual(["乙", "甲"]);   // 标签是集合，读回按库排序
    expect(copy.mentions).toEqual([{ type: "user", id: creator }]);
    expect(copy.createdBy).toBe(builder);

    const node = (await getNodeByWikiId(copy.id))!;
    expect(node.parentId).toBe(parent.nodeId);
    expect(node.listable).toBe(false);
    expect(node.isPublic).toBe(false);   // 公开位是原件的分享面，副本是新建

    const siblings = (await listNodeLibrary(prodId))
      .filter(n => n.parentId === parent.nodeId).map(n => n.wikiId);
    expect(siblings).toEqual([src.id, copy.id, after.id]);

    const { rows } = await getPool().query(
      `SELECT user_id FROM production_member_grant WHERE resource_type = 'wiki' AND resource_id = $1 AND user_id = $2`,
      [copy.id, stranger]);
    expect(rows).toHaveLength(0);   // 原件对 stranger 的分享没跟过来

    // 修订记录随建落一条（含提及），原件不受影响
    const rev = await getPool().query<{ mentions: unknown }>(
      `SELECT mentions FROM wiki_revision WHERE wiki_id = $1::uuid`, [copy.id]);
    expect(rev.rows).toHaveLength(1);
    expect(rev.rows[0].mentions).toEqual([{ type: "user", id: creator }]);
    expect((await getWiki(src.id, prodId))!.title).toBe("原件");
  });

  it("不存在的原件返回 null", async () => {
    expect(await duplicateWiki("00000000-0000-4000-8000-000000000000", prodId, creator)).toBeNull();
  });
});

describe("POST /wiki/[id]/duplicate 三门", () => {
  it("读不到原件 → 403（有 create 也不行）", async () => {
    const priv = await createWiki({ productionId: prodId, title: "私有", createdBy: creator });
    const res = await duplicatePOST(req(prodId, priv.id, builder), ctx(prodId, priv.id));
    expect(res.status).toBe(403);
  });
  it("能读但无 create → 403", async () => {
    const w = await createWiki({ productionId: prodId, title: "只读可见", createdBy: creator });
    await shareView(prodId, w.id, stranger);
    const res = await duplicatePOST(req(prodId, w.id, stranger), ctx(prodId, w.id));
    expect(res.status).toBe(403);
  });
  it("能读 ∧ 有 create → 201，副本归请求者所有", async () => {
    const w = await createWiki({ productionId: prodId, title: "可复制", body: "abc", createdBy: creator });
    await shareView(prodId, w.id, builder);
    const res = await duplicatePOST(req(prodId, w.id, builder), ctx(prodId, w.id));
    expect(res.status).toBe(201);
    const { wiki } = await res.json() as { wiki: { id: string; title: string; body: string; createdBy: string } };
    expect(wiki.title).toBe("可复制 副本");
    expect(wiki.body).toBe("abc");
    expect(wiki.createdBy).toBe(builder);
  });
  it("原件不存在 → 404", async () => {
    const res = await duplicatePOST(
      req(prodId, "00000000-0000-4000-8000-000000000000", creator),
      ctx(prodId, "00000000-0000-4000-8000-000000000000"));
    expect(res.status).toBe(404);
  });
});
