// 缺省落点（#420 第二批收官）：resolveDefaultLanding 各上下文 + wiki POST
// 路由级接入。原则回归：event 系归事件目录链、report 内容嵌套 report 节点、
// 无缺省上下文回 null、门不过回退不 403。
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { getPool } from "@/lib/pg";
import { createSession, SESSION_COOKIE } from "@/lib/session";
import { resolveDefaultLanding, readLandingContext } from "@/lib/node/landing";
import { createWiki } from "@/lib/wiki/content";
import { getNodeByWikiId } from "@/lib/node/db";
import { POST as wikiPOST } from "@/app/api/production/[id]/wiki/route";
import { POST as assetsPOST } from "@/app/api/production/[id]/assets/route";
import { makeProduction, cleanupProduction, shortId } from "./factories";

async function newMember(prodId: string): Promise<string> {
  const pool = getPool();
  const res = await pool.query<{ id: string }>("INSERT INTO app_user DEFAULT VALUES RETURNING id");
  const id = res.rows[0].id;
  await pool.query(`INSERT INTO production_member (production_id, user_id, roles) VALUES ($1, $2, '{}')`, [prodId, id]);
  return id;
}

let prodId: string;
let userId: string;
let eventId: string;
const actorOf = (id: string) => ({ userId: id, isAdmin: false, isOwner: false });

beforeAll(async () => {
  ({ prodId } = await makeProduction());
  userId = await newMember(prodId);
  // canEnterEvent 前置（AI review 后加的写前干系判定）：给测试用户事件域票
  await getPool().query(
    `INSERT INTO production_member_grant (production_id, user_id, resource_type, resource_id, resource_sub, permission_level, grant_source)
     VALUES ($1, $2::uuid, 'event', '*', 'meta', 'view', 'auto')`,
    [prodId, userId],
  );
  eventId = shortId();
  await getPool().query(
    `INSERT INTO production_event (id, production_id, title, created_by) VALUES ($1, $2, '落点测试事件', $3::uuid)`,
    [eventId, prodId, userId],
  );
});

afterAll(async () => {
  await cleanupProduction(prodId).catch(() => {});
});

describe("resolveDefaultLanding", () => {
  it("event → 事件目录（懒建）；event_schedule/task(挂事件) 归同一目录", async () => {
    const dir = await resolveDefaultLanding(actorOf(userId), prodId, { kind: "mount", mountType: "event", mountId: eventId });
    expect(dir).toBeTruthy();
    const { rows: [d] } = await getPool().query<{ kind: string; parent_id: string }>(
      `SELECT kind, parent_id FROM node WHERE id = $1`, [dir]);
    expect(d.kind).toBe("wiki"); // 事件目录是 wiki 容器锚点

    const itemId = shortId();
    await getPool().query(
      `INSERT INTO event_schedule_item (id, event_id, title) VALUES ($1, $2, '流程项')`,
      [itemId, eventId]);
    expect(await resolveDefaultLanding(actorOf(userId), prodId, { kind: "mount", mountType: "event_schedule", mountId: itemId }))
      .toBe(dir);

    const taskId = shortId();
    await getPool().query(
      `INSERT INTO task (id, production_id, title, event_id) VALUES ($1, $2, '挂事件任务', $3)`,
      [taskId, prodId, eventId]);
    expect(await resolveDefaultLanding(actorOf(userId), prodId, { kind: "mount", mountType: "task", mountId: taskId }))
      .toBe(dir);
  });

  it("与 event 无干系者 → null（ensure 写前干系判定，不留副作用）", async () => {
    const outsider = await newMember(prodId);
    expect(await resolveDefaultLanding(actorOf(outsider), prodId,
      { kind: "mount", mountType: "event", mountId: eventId })).toBeNull();
  });

  it("独立 task / scene / 幽灵 id → null（无缺省，布局待拍板）", async () => {
    const loneTask = shortId();
    await getPool().query(
      `INSERT INTO task (id, production_id, title) VALUES ($1, $2, '独立任务')`, [loneTask, prodId]);
    expect(await resolveDefaultLanding(actorOf(userId), prodId, { kind: "mount", mountType: "task", mountId: loneTask })).toBeNull();
    expect(await resolveDefaultLanding(actorOf(userId), prodId, { kind: "mount", mountType: "scene", mountId: "sc_x" })).toBeNull();
    expect(await resolveDefaultLanding(actorOf(userId), prodId, { kind: "mount", mountType: "event", mountId: "ev_ghost" })).toBeNull();
  });

  it("doc-sibling：与正文同级；顶层文档 → null（回缺省，树顶不积散件）", async () => {
    const parent = await createWiki({ productionId: prodId, title: "落点父", createdBy: userId });
    const child = await createWiki({
      productionId: prodId, title: "落点子", createdBy: userId, parentNodeId: parent.nodeId,
    });
    expect(await resolveDefaultLanding(actorOf(userId), prodId, { kind: "doc-sibling", wikiId: child.id }))
      .toBe(parent.nodeId);
    expect(await resolveDefaultLanding(actorOf(userId), prodId, { kind: "doc-sibling", wikiId: parent.id })).toBeNull();
  });

  it("readLandingContext：非法形状一律 undefined", () => {
    expect(readLandingContext(undefined)).toBeUndefined();
    expect(readLandingContext("x")).toBeUndefined();
    expect(readLandingContext({ kind: "mount", mountType: "event" })).toBeUndefined();
    expect(readLandingContext({ kind: "doc-sibling", wikiId: "" })).toBeUndefined();
    expect(readLandingContext({ kind: "mount", mountType: "event", mountId: "e1" }))
      .toEqual({ kind: "mount", mountType: "event", mountId: "e1" });
  });
});

describe("wiki POST 路由级接入", () => {
  it("landing=event 上下文 → 文档落进事件目录；scene 上下文 → 落顶层", async () => {
    await getPool().query(
      `INSERT INTO production_member_grant (production_id, user_id, resource_type, resource_id, resource_sub, permission_level, grant_source)
       VALUES ($1, $2::uuid, 'wiki', '*', '*', 'create', 'auto')`,
      [prodId, userId],
    );
    const cookie = `${SESSION_COOKIE}=${createSession({ userId, name: "测试", avatarUrl: null, isAdmin: false })}`;
    const mkReq = (body: unknown) => new NextRequest(`http://localhost/api/production/${prodId}/wiki`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify(body),
    });
    const ctx = { params: Promise.resolve({ id: prodId }) };

    const res = await wikiPOST(mkReq({
      title: "事件附文", landing: { kind: "mount", mountType: "event", mountId: eventId },
    }), ctx);
    expect(res.status).toBe(201);
    const { wiki } = await res.json() as { wiki: { id: string } };
    const dir = await resolveDefaultLanding(actorOf(userId), prodId, { kind: "mount", mountType: "event", mountId: eventId });
    expect((await getNodeByWikiId(wiki.id))!.parentId).toBe(dir);

    const res2 = await wikiPOST(mkReq({
      title: "场景附文", landing: { kind: "mount", mountType: "scene", mountId: "sc_x" },
    }), ctx);
    expect(res2.status).toBe(201);
    const { wiki: w2 } = await res2.json() as { wiki: { id: string } };
    expect((await getNodeByWikiId(w2.id))!.parentId).toBeNull();
  });

  it("assets POST landing=event → 壳节点落进事件目录", async () => {
    await getPool().query(
      `INSERT INTO production_member_grant (production_id, user_id, resource_type, resource_id, resource_sub, permission_level, grant_source)
       VALUES ($1, $2::uuid, 'asset', '*', '*', 'create', 'auto')`,
      [prodId, userId],
    );
    const cookie = `${SESSION_COOKIE}=${createSession({ userId, name: "测试", avatarUrl: null, isAdmin: false })}`;
    const res = await assetsPOST(new NextRequest(`http://localhost/api/production/${prodId}/assets`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        storageType: "feishu_link", feishuUrl: "https://feishu.example/land",
        fileName: "落点附件.txt", assetType: "reference",
        landing: { kind: "mount", mountType: "event", mountId: eventId },
      }),
    }), { params: Promise.resolve({ id: prodId }) });
    expect(res.status).toBe(201);
    const { asset } = await res.json() as { asset: { id: string } };
    const dir = await resolveDefaultLanding(actorOf(userId), prodId,
      { kind: "mount", mountType: "event", mountId: eventId });
    const { rows: [n] } = await getPool().query<{ parent_id: string }>(
      `SELECT parent_id FROM node WHERE asset_id = $1`, [asset.id]);
    expect(n.parent_id).toBe(dir);
  });
});
