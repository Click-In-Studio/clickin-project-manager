import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { getPool } from "@/lib/pg";
import { createSession, SESSION_COOKIE } from "@/lib/session";
import { createWiki, updateWiki, deleteWiki, getWiki } from "@/lib/wiki/content";
import { extractWikiLinkTargets, listBacklinks, listUnlinkedReferences } from "@/lib/wiki/links";
import { setNodePublic, setNodeDeptShares, moveNode, getNodeByWikiId } from "@/lib/node/db";
import { canViewWiki, listVisibleWikiIds } from "@/lib/wiki/perm";
import { WIKI_LEVEL_ROW_SETS } from "@/lib/resource-grant-db";
import { createEventReport } from "@/lib/event-db";
import { GET as wikiListGET, POST as wikiPOST } from "@/app/api/production/[id]/wiki/route";
import { GET as wikiGET } from "@/app/api/production/[id]/wiki/[wikiId]/route";
import { PUT as sharePUT } from "@/app/api/production/[id]/wiki/[wikiId]/share/route";
import { makeProduction, cleanupProduction, shortId } from "./factories";

// wiki 文档库 W3：可见性矩阵 / 链接图 / 树约束 / 路由门
// 设计账本：《wiki文档库-现状调研与实施路线》§4.1/§4.2/§5

async function newUser(): Promise<string> {
  const res = await getPool().query<{ id: string }>("INSERT INTO app_user DEFAULT VALUES RETURNING id");
  return res.rows[0].id;
}
async function newMember(prodId: string): Promise<string> {
  const uid = await newUser();
  await getPool().query(
    `INSERT INTO production_member (production_id, user_id, roles) VALUES ($1, $2, '{}')`,
    [prodId, uid],
  );
  return uid;
}
const actorOf = (userId: string) => ({ userId, isAdmin: false, isOwner: false });

let prodId: string;
let creator: string;
let stranger: string;
const users: string[] = [];

beforeAll(async () => {
  ({ prodId } = await makeProduction());
  creator = await newMember(prodId);
  stranger = await newMember(prodId);
  users.push(creator, stranger);
});

afterAll(async () => {
  await getPool().query(
    `DELETE FROM production_event WHERE production_id = $1`, [prodId]).catch(() => {});
  await cleanupProduction(prodId).catch(() => {});
  await getPool().query("DELETE FROM app_user WHERE id = ANY($1)", [users]).catch(() => {});
});

describe("visibility matrix (§4.2)", () => {
  it("creator sees own doc; other member does not (default private)", async () => {
    const w = await createWiki({ productionId: prodId, title: "私有文档", createdBy: creator });
    expect(await canViewWiki(actorOf(creator), prodId, w.id)).toBe(true);
    expect(await canViewWiki(actorOf(stranger), prodId, w.id)).toBe(false);
    const visible = await listVisibleWikiIds(actorOf(stranger), prodId);
    expect(visible.wildcard).toBe(false);
    expect(visible.ids.has(w.id)).toBe(false);
  });

  it("is_public makes it visible to any member", async () => {
    const w = await createWiki({ productionId: prodId, title: "公开文档", createdBy: creator });
    await setNodePublic(w.nodeId, prodId, true);
    expect(await canViewWiki(actorOf(stranger), prodId, w.id)).toBe(true);
    const visible = await listVisibleWikiIds(actorOf(stranger), prodId);
    expect(visible.ids.has(w.id)).toBe(true);
  });

  it("dept share reaches dept members only, tracks membership live", async () => {
    const w = await createWiki({ productionId: prodId, title: "部门文档", createdBy: creator });
    const { rows: [{ id: deptId }] } = await getPool().query<{ id: string }>(
      `INSERT INTO production_dept (production_id, name) VALUES ($1, '道具') RETURNING id`, [prodId]);
    await setNodeDeptShares(w.nodeId, prodId, [deptId]);
    expect(await canViewWiki(actorOf(stranger), prodId, w.id)).toBe(false);
    await getPool().query(
      `INSERT INTO production_dept_member (production_id, dept_id, user_id) VALUES ($1, $2, $3)`,
      [prodId, deptId, stranger]);
    expect(await canViewWiki(actorOf(stranger), prodId, w.id)).toBe(true);
    // 退组即收缩（零 sweep）
    await getPool().query(
      `DELETE FROM production_dept_member WHERE dept_id = $1 AND user_id = $2`, [deptId, stranger]);
    expect(await canViewWiki(actorOf(stranger), prodId, w.id)).toBe(false);
  });

  it("person share via row set grants view", async () => {
    const w = await createWiki({ productionId: prodId, title: "点对点分享", createdBy: creator });
    for (const [sub, verb] of WIKI_LEVEL_ROW_SETS.view) {
      await getPool().query(
        `INSERT INTO production_member_grant
           (production_id, user_id, resource_type, resource_id, resource_sub, permission_level, grant_source, confirmed_by)
         VALUES ($1, $2, 'wiki', $3, $4, $5, 'direct', $2)`,
        [prodId, stranger, w.id, sub, verb]);
    }
    expect(await canViewWiki(actorOf(stranger), prodId, w.id)).toBe(true);
  });

  it("mounted as published report → visible with event domain view; draft → not", async () => {
    const viewer = await newMember(prodId);
    users.push(viewer);
    await getPool().query(
      `INSERT INTO production_member_grant
         (production_id, user_id, resource_type, resource_id, resource_sub, permission_level, grant_source, confirmed_by)
       VALUES ($1, $2, 'event', '*', 'details', 'view', 'direct', $2)`,
      [prodId, viewer]);

    const eventId = `ev${shortId()}`;
    await getPool().query(
      `INSERT INTO production_event (id, production_id, title, created_by, status) VALUES ($1, $2, '排练', $3, 'published')`,
      [eventId, prodId, creator]);
    const reportId = `rp${shortId()}`;
    await createEventReport({
      id: reportId, eventId, reportType: "rehearsal", title: "draft 报告", body: "x", createdBy: creator });
    const wikiId = (await getPool().query<{ wiki_id: string }>(
      `SELECT wiki_id::text AS wiki_id FROM event_report WHERE id = $1`, [reportId])).rows[0].wiki_id;

    expect(await canViewWiki(actorOf(viewer), prodId, wikiId)).toBe(false);
    await getPool().query(
      `UPDATE event_report SET published_at = now() WHERE id = $1`, [reportId]);
    expect(await canViewWiki(actorOf(viewer), prodId, wikiId)).toBe(true);
    const visible = await listVisibleWikiIds(actorOf(viewer), prodId);
    expect(visible.ids.has(wikiId)).toBe(true);
  });

  it("draft report wiki visible to dept participant of the event", async () => {
    const participant = await newMember(prodId);
    users.push(participant);
    const eventId = `ev${shortId()}`;
    await getPool().query(
      `INSERT INTO production_event (id, production_id, title, created_by, status) VALUES ($1, $2, '联排', $3, 'published')`,
      [eventId, prodId, creator]);
    const { rows: [{ id: deptId }] } = await getPool().query<{ id: string }>(
      `INSERT INTO production_dept (production_id, name) VALUES ($1, '灯光二') RETURNING id`, [prodId]);
    await getPool().query(
      `INSERT INTO event_participant (id, event_id, user_id, name, department_id) VALUES ($1, $2, $3, '参与', $4)`,
      [`ep${shortId()}`, eventId, participant, deptId]);
    const reportId = `rp${shortId()}`;
    await createEventReport({
      id: reportId, eventId, reportType: "rehearsal", title: "未发布", body: "x", createdBy: creator });
    const wikiId = (await getPool().query<{ wiki_id: string }>(
      `SELECT wiki_id::text AS wiki_id FROM event_report WHERE id = $1`, [reportId])).rows[0].wiki_id;
    expect(await canViewWiki(actorOf(participant), prodId, wikiId)).toBe(true);
  });
});

describe("link graph", () => {
  it("extracts both serialization forms", () => {
    const a = "11111111-2222-3333-4444-555555555555";
    const b = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const body = `见 [#wiki:${a}] 与 [引用](/__cm__wiki:${b}) 及正常链接 [x](https://e.com)`;
    expect(extractWikiLinkTargets(body).sort()).toEqual([a, b].sort());
  });

  it("ignores link syntax inside code fences and inline code (documentation, not references)", () => {
    const a = "11111111-2222-3333-4444-555555555555";
    const b = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const body = "语法示例：`[#wiki:" + a + "]`\n```\n[引用](/__cm__wiki:" + b + ")\n```\n真引用 [#wiki:" + a + "]";
    expect(extractWikiLinkTargets(body)).toEqual([a]);
  });

  it("save syncs wiki_link; backlinks and unlinked references work", async () => {
    const target = await createWiki({ productionId: prodId, title: "目标文档甲", createdBy: creator });
    const source = await createWiki({
      productionId: prodId, title: "来源", body: `引用 [#wiki:${target.id}]`, createdBy: creator });
    expect((await listBacklinks(target.id, prodId)).map(r => r.id)).toContain(source.id);

    // unlinked：正文含标题但无链接边
    const mentioner = await createWiki({
      productionId: prodId, title: "提及者", body: "这里提到了目标文档甲但没有链接", createdBy: creator });
    const unlinked = (await listUnlinkedReferences(target.id, prodId)).map(r => r.id);
    expect(unlinked).toContain(mentioner.id);
    expect(unlinked).not.toContain(source.id);

    // 更新移除引用 → 反链消失
    await updateWiki(source.id, prodId, { body: "不再引用" }, creator);
    expect((await listBacklinks(target.id, prodId)).map(r => r.id)).not.toContain(source.id);
  });
});

describe("tree constraints & delete", () => {
  it("rejects cycle (re-parenting under own descendant)", async () => {
    const a = await createWiki({ productionId: prodId, title: "环A", createdBy: creator });
    const b = await createWiki({ productionId: prodId, title: "环B", parentNodeId: a.nodeId, createdBy: creator });
    await expect(moveNode(a.nodeId, prodId, { parentId: b.nodeId })).rejects.toThrow();
  });

  // 父 id 直接进 $n::uuid，空串会炸成 invalid input syntax for type uuid——
  // 而"没有父文档"最自然的写法恰恰是空串（MCP 工具那边模型真这么传）。
  it("空串父 id 当作根目录，不炸语法（#420 位置面在 node 域）", async () => {
    const root = await createWiki({ productionId: prodId, title: "空串父", parentNodeId: "", createdBy: creator });
    expect((await getNodeByWikiId(root.id))?.parentId).toBeNull();

    const parent = await createWiki({ productionId: prodId, title: "真父", createdBy: creator });
    const child = await createWiki({ productionId: prodId, title: "子", parentNodeId: parent.nodeId, createdBy: creator });
    expect((await getNodeByWikiId(child.id))?.parentId).toBe(parent.nodeId);
    // 空串移动 = 移回根
    const moved = await moveNode(child.nodeId, prodId, { parentId: "" });
    expect(moved?.parentId).toBeNull();
  });

  it("mounted wiki cannot be deleted; standalone delete revokes grants", async () => {
    const eventId = `ev${shortId()}`;
    await getPool().query(
      `INSERT INTO production_event (id, production_id, title, created_by, status) VALUES ($1, $2, 'E', $3, 'published')`,
      [eventId, prodId, creator]);
    const reportId = `rp${shortId()}`;
    await createEventReport({
      id: reportId, eventId, reportType: "rehearsal", title: "挂载中", body: "x", createdBy: creator });
    const mountedWikiId = (await getPool().query<{ wiki_id: string }>(
      `SELECT nd.wiki_id::text AS wiki_id FROM event_report er JOIN node nd ON nd.id = er.node_id
       WHERE er.id = $1`, [reportId])).rows[0].wiki_id;
    expect(await deleteWiki(mountedWikiId, prodId)).toEqual({ ok: false, reason: "mounted" });

    const standalone = await createWiki({ productionId: prodId, title: "待删", createdBy: creator });
    expect(await deleteWiki(standalone.id, prodId)).toEqual({ ok: true });
    expect(await getWiki(standalone.id, prodId)).toBeNull();
    const grants = await getPool().query(
      `SELECT 1 FROM production_member_grant WHERE resource_type = 'wiki' AND resource_id = $1`,
      [standalone.id]);
    expect(grants.rows.length).toBe(0);
  });
});

describe("routes", () => {
  const cookieFor = (userId: string, isAdmin = false) =>
    `${SESSION_COOKIE}=${createSession({ userId, name: "测试", avatarUrl: null, isAdmin })}`;
  const listCtx = { params: Promise.resolve({ id: "" }) };

  function makeReq(method: string, url: string, userId: string, isAdmin = false, body?: unknown) {
    return new NextRequest(`http://localhost${url}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        Cookie: cookieFor(userId, isAdmin),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  }

  it("POST create is gated (member without create row → 403; admin → 201)", async () => {
    const ctx = { params: Promise.resolve({ id: prodId }) };
    const denied = await wikiPOST(
      makeReq("POST", `/api/production/${prodId}/wiki`, stranger, false, { title: "不该建成" }), ctx);
    expect(denied.status).toBe(403);

    const ok = await wikiPOST(
      makeReq("POST", `/api/production/${prodId}/wiki`, creator, true, { title: "管理员建" }), ctx);
    expect(ok.status).toBe(201);
  });

  // #357：树列表走**枚举面**，不再是内容面——默认 listable 的文档标题进目录，
  // 读不读得了由 GET 详情的内容门决定（名字可见 ≠ 内容可见）。
  it("GET list returns enumerable docs (name), detail still 403s (content)", async () => {
    const secret = await createWiki({ productionId: prodId, title: "标题可见正文不可见", createdBy: creator });
    const ctx = { params: Promise.resolve({ id: prodId }) };
    const res = await wikiListGET(makeReq("GET", `/api/production/${prodId}/wiki`, stranger), ctx);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect((data.wikis as { id: string }[]).map(w => w.id)).toContain(secret.id);

    const detail = await wikiGET(
      makeReq("GET", `/api/production/${prodId}/wiki/${secret.id}`, stranger),
      { params: Promise.resolve({ id: prodId, wikiId: secret.id }) });
    expect(detail.status).toBe(403);
  });

  it("GET list omits non-listable docs entirely", async () => {
    const hidden = await createWiki({
      productionId: prodId, title: "不可枚举", createdBy: creator, listable: false });
    const ctx = { params: Promise.resolve({ id: prodId }) };
    const res = await wikiListGET(makeReq("GET", `/api/production/${prodId}/wiki`, stranger), ctx);
    const data = await res.json();
    expect((data.wikis as { id: string }[]).map(w => w.id)).not.toContain(hidden.id);
  });

  it("GET instance without permission → 403 carrying title (目录级) and apply anchor", async () => {
    const secret = await createWiki({ productionId: prodId, title: "标题可见内容不可见", createdBy: creator });
    const ctx = { params: Promise.resolve({ id: prodId, wikiId: secret.id }) };
    const res = await wikiGET(
      makeReq("GET", `/api/production/${prodId}/wiki/${secret.id}`, stranger), ctx);
    expect(res.status).toBe(403);
    const data = await res.json();
    expect(data.title).toBe("标题可见内容不可见");
    expect(data.applyResource).toBe(`node:wiki/${secret.id}@view`);
    expect(data.wiki).toBeUndefined();
  });

  it("share PUT addPerson makes target visible; removePerson revokes", async () => {
    const doc = await createWiki({ productionId: prodId, title: "分享流转", createdBy: creator });
    const ctx = { params: Promise.resolve({ id: prodId, wikiId: doc.id }) };
    const add = await sharePUT(
      makeReq("PUT", `/api/production/${prodId}/wiki/${doc.id}/share`, creator, false,
        { addPerson: { userId: stranger, level: "view" } }), ctx);
    expect(add.status).toBe(200);
    expect(await canViewWiki(actorOf(stranger), prodId, doc.id)).toBe(true);

    const rm = await sharePUT(
      makeReq("PUT", `/api/production/${prodId}/wiki/${doc.id}/share`, creator, false,
        { removePersonUserId: stranger }), ctx);
    expect(rm.status).toBe(200);
    expect(await canViewWiki(actorOf(stranger), prodId, doc.id)).toBe(false);
  });
});
