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
import { makeProduction, cleanupProduction, makeBlocks, makeScene, shortId } from "./factories";

async function newMember(prodId: string): Promise<string> {
  const pool = getPool();
  const res = await pool.query<{ id: string }>("INSERT INTO app_user DEFAULT VALUES RETURNING id");
  const id = res.rows[0].id;
  await pool.query(`INSERT INTO production_member (production_id, user_id, roles) VALUES ($1, $2, '{}')`, [prodId, id]);
  return id;
}

let prodId: string;
let versionId: string;
let userId: string;
let eventId: string;
const actorOf = (id: string) => ({ userId: id, isAdmin: false, isOwner: false });

beforeAll(async () => {
  ({ prodId, versionId } = await makeProduction());
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

  it("block → 「剧本」单目录；cue → 「Cue/<表名>」并惰性跟随改名", async () => {
    // 干系票
    await getPool().query(
      `INSERT INTO production_member_grant (production_id, user_id, resource_type, resource_id, resource_sub, permission_level, grant_source)
       VALUES ($1, $2::uuid, 'script', '*', 'blocks', 'view', 'auto')`,
      [prodId, userId]);
    const [blockId] = await makeBlocks(prodId, versionId, 1);
    const scriptDir = await resolveDefaultLanding(actorOf(userId), prodId,
      { kind: "mount", mountType: "block", mountId: blockId });
    expect(scriptDir).toBeTruthy();
    const { rows: [sd] } = await getPool().query<{ title: string; kind: string; parent_id: string | null }>(
      `SELECT title, kind, parent_id FROM node WHERE id = $1`, [scriptDir]);
    expect(sd).toMatchObject({ title: "剧本", kind: "folder", parent_id: null });
    // 幂等：再次解析同一目录，且同名重放不触碰 updated_at（IS DISTINCT FROM 守卫）
    const { rows: [before] } = await getPool().query<{ updated_at: Date }>(
      `SELECT updated_at FROM node WHERE id = $1`, [scriptDir]);
    expect(await resolveDefaultLanding(actorOf(userId), prodId,
      { kind: "mount", mountType: "block", mountId: blockId })).toBe(scriptDir);
    const { rows: [after] } = await getPool().query<{ updated_at: Date }>(
      `SELECT updated_at FROM node WHERE id = $1`, [scriptDir]);
    expect(after.updated_at.getTime()).toBe(before.updated_at.getTime());

    // cue：建表+稳定 id
    const listId = shortId(); const cueStable = shortId();
    await getPool().query(
      `INSERT INTO cue_list (id, production_id, name, created_by) VALUES ($1, $2, '灯光CUE', $3::uuid)`,
      [listId, prodId, userId]);
    await getPool().query(
      `INSERT INTO cue (id, cue_list_id, number, start_kind, end_kind, cue_id)
       VALUES ($1, $2, '1', 'gap', 'gap', $3)`, [shortId(), listId, cueStable]);
    await getPool().query(
      `INSERT INTO production_member_grant (production_id, user_id, resource_type, resource_id, resource_sub, permission_level, grant_source)
       VALUES ($1, $2::uuid, 'cue_list', $3, 'cues', 'view', 'auto')`,
      [prodId, userId, listId]);
    const listDir = await resolveDefaultLanding(actorOf(userId), prodId,
      { kind: "mount", mountType: "cue", mountId: cueStable });
    expect(listDir).toBeTruthy();
    const { rows: [ld] } = await getPool().query<{ title: string; parent_id: string }>(
      `SELECT title, parent_id FROM node WHERE id = $1`, [listDir]);
    expect(ld.title).toBe("灯光CUE");
    const { rows: [root] } = await getPool().query<{ title: string; parent_id: string | null }>(
      `SELECT title, parent_id FROM node WHERE id = $1`, [ld.parent_id]);
    expect(root).toMatchObject({ title: "Cue", parent_id: null });

    // 名字惰性跟随：改表名 → 下次解析目录标题对齐
    await getPool().query(`UPDATE cue_list SET name = '灯光CUE v2' WHERE id = $1`, [listId]);
    expect(await resolveDefaultLanding(actorOf(userId), prodId,
      { kind: "mount", mountType: "cue", mountId: cueStable })).toBe(listDir);
    const { rows: [ld2] } = await getPool().query<{ title: string }>(
      `SELECT title FROM node WHERE id = $1`, [listDir]);
    expect(ld2.title).toBe("灯光CUE v2");
  });

  it("scene → 「场景/<场名>」per-scene 目录", async () => {
    await getPool().query(
      `INSERT INTO production_member_grant (production_id, user_id, resource_type, resource_id, resource_sub, permission_level, grant_source)
       VALUES ($1, $2::uuid, 'scene', '*', 'meta', 'view', 'auto')`,
      [prodId, userId]);
    const sceneId = await makeScene(prodId, versionId, { name: "序幕" });
    const dir = await resolveDefaultLanding(actorOf(userId), prodId,
      { kind: "mount", mountType: "scene", mountId: sceneId });
    expect(dir).toBeTruthy();
    const { rows: [d] } = await getPool().query<{ title: string; parent_id: string }>(
      `SELECT title, parent_id FROM node WHERE id = $1`, [dir]);
    expect(d.title).toBe("序幕");
    const { rows: [root] } = await getPool().query<{ title: string; parent_id: string | null }>(
      `SELECT title, parent_id FROM node WHERE id = $1`, [d.parent_id]);
    expect(root).toMatchObject({ title: "场景", parent_id: null });
    // 幽灵 scene id → null
    expect(await resolveDefaultLanding(actorOf(userId), prodId,
      { kind: "mount", mountType: "scene", mountId: "sc_ghost" })).toBeNull();
  });

  it("独立 task / comment / 幽灵 id → null（无缺省）", async () => {
    const loneTask = shortId();
    await getPool().query(
      `INSERT INTO task (id, production_id, title) VALUES ($1, $2, '独立任务')`, [loneTask, prodId]);
    expect(await resolveDefaultLanding(actorOf(userId), prodId, { kind: "mount", mountType: "task", mountId: loneTask })).toBeNull();
    expect(await resolveDefaultLanding(actorOf(userId), prodId, { kind: "mount", mountType: "comment", mountId: "c_x" })).toBeNull();
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
