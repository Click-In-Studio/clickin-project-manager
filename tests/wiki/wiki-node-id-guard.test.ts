import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { getPool } from "@/lib/pg";
import { createSession, SESSION_COOKIE } from "@/lib/account/session";
import { isWikiId } from "@/lib/wiki/id";
import { createWiki, getWiki } from "@/lib/wiki/content";
import { canViewWiki } from "@/lib/wiki/perm";
import { listOutgoingLinks, listEntityRefsForWiki, listUnlinkedReferences } from "@/lib/wiki/links";
import { newNodeId } from "@/lib/node/db";
import { GET as wikiGET } from "@/app/api/production/[id]/wiki/[wikiId]/route";
import { GET as backlinksGET } from "@/app/api/production/[id]/wiki/[wikiId]/backlinks/route";
import { GET as streamGET } from "@/app/api/production/[id]/wiki/[wikiId]/stream/route";
import { POST as presencePOST } from "@/app/api/production/[id]/wiki/[wikiId]/presence/route";
import { PUT as sharePUT } from "@/app/api/production/[id]/wiki/[wikiId]/share/route";
import { makeProduction, cleanupProduction } from "../_support/factories";

// #476：`nd_` 壳节点 id 流进 wiki 的 uuid 查询 → PG 22P02 → 未捕获 → 线上 500。
//
// `[wikiId]` 路由段共用两种 id 是**有意设计**（#358 → #420：软链接/资产壳节点
// 就地渲染，不 302 弹出工作区），所以修在消费侧：每个把入参喂给 `$1::uuid` 的
// 入口先过形状闸，形状不对＝按「不存在 / 不可见」答。

/** 线上 PG 日志里真实炸过的两个 id（都是资产壳节点）。 */
const PROD_LOG_IDS = ["nd_45052c2039bbab", "nd_bf4d800784b04d"];

async function newMember(prodId: string): Promise<string> {
  const res = await getPool().query<{ id: string }>("INSERT INTO app_user DEFAULT VALUES RETURNING id");
  const uid = res.rows[0].id;
  await getPool().query(
    `INSERT INTO production_member (production_id, user_id, roles) VALUES ($1, $2, '{}')`,
    [prodId, uid],
  );
  return uid;
}
const actorOf = (userId: string, isAdmin = false) => ({ userId, isAdmin, isOwner: false });

let prodId: string;
let member: string;
let nodeId: string;
const users: string[] = [];

beforeAll(async () => {
  ({ prodId } = await makeProduction());
  member = await newMember(prodId);
  users.push(member);
  nodeId = newNodeId();
});

afterAll(async () => {
  await cleanupProduction(prodId).catch(() => {});
  await getPool().query("DELETE FROM app_user WHERE id = ANY($1)", [users]).catch(() => {});
});

describe("形状闸本身", () => {
  it("uuid 认，nd_ 短 id 不认", async () => {
    const doc = await createWiki({ productionId: prodId, title: "形状样本", createdBy: member });
    expect(isWikiId(doc.id)).toBe(true);
    expect(isWikiId(doc.id.toUpperCase())).toBe(true);
    expect(isWikiId(newNodeId())).toBe(false);
    for (const id of PROD_LOG_IDS) expect(isWikiId(id)).toBe(false);
    expect(isWikiId("")).toBe(false);
    // 前缀/后缀带脏的 uuid 也不算——`$1::uuid` 同样会拒
    expect(isWikiId(`nd_${doc.id}`)).toBe(false);
    expect(isWikiId(`${doc.id} `)).toBe(false);
  });

  it("反证：没有闸时 PG 确实抛 22P02（闸是承重的，不是装饰）", async () => {
    await expect(
      getPool().query(`SELECT 1 FROM wiki WHERE id = $1::uuid`, [nodeId]),
    ).rejects.toMatchObject({ code: "22P02" });
  });
});

describe("lib 入口：非 uuid 入参按不存在/不可见答，不抛", () => {
  it("getWiki(nd_…) → null", async () => {
    expect(await getWiki(nodeId, prodId)).toBeNull();
    for (const id of PROD_LOG_IDS) expect(await getWiki(id, prodId)).toBeNull();
  });

  it("canViewWiki(nd_…) → false，admin 也一样（旁路在闸之后）", async () => {
    expect(await canViewWiki(actorOf(member), prodId, nodeId)).toBe(false);
    // admin 旁路若在闸之前，就会给 `nd_…` 发一张空头通行证，
    // 让它继续流进 backlinks 那条链上的 uuid 查询再炸一次。
    expect(await canViewWiki(actorOf(member, true), prodId, nodeId)).toBe(false);
  });

  it("链接图三个 uuid 入口 → 空集", async () => {
    expect(await listOutgoingLinks(nodeId, prodId)).toEqual([]);
    expect(await listEntityRefsForWiki(nodeId, prodId)).toEqual([]);
    expect(await listUnlinkedReferences(nodeId, prodId)).toEqual([]);
  });
});

describe("路由：`nd_` 段不再 500", () => {
  const cookieFor = (userId: string, isAdmin = false) =>
    `${SESSION_COOKIE}=${createSession({ userId, name: "测试", avatarUrl: null, isAdmin })}`;

  function makeReq(method: string, url: string, userId: string, isAdmin = false, body?: unknown) {
    return new NextRequest(`http://localhost${url}`, {
      method,
      headers: { "Content-Type": "application/json", Cookie: cookieFor(userId, isAdmin) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  }

  it("GET 文档详情 → 404（AgentPopout 的「附带当前文档」chip 走的就是这条）", async () => {
    for (const isAdmin of [false, true]) {
      const res = await wikiGET(
        makeReq("GET", `/api/production/${prodId}/wiki/${nodeId}`, member, isAdmin),
        { params: Promise.resolve({ id: prodId, wikiId: nodeId }) });
      expect(res.status).toBe(404);
    }
  });

  it("GET backlinks → 403（内容门先拦，不落到 uuid 查询上）", async () => {
    const res = await backlinksGET(
      makeReq("GET", `/api/production/${prodId}/wiki/${nodeId}/backlinks`, member, true),
      { params: Promise.resolve({ id: prodId, wikiId: nodeId }) });
    expect(res.status).toBe(403);
  });

  it("GET stream → 403（门在建流之前，不会挂出一条永远等不到帧的 SSE）", async () => {
    const res = await streamGET(
      makeReq("GET", `/api/production/${prodId}/wiki/${nodeId}/stream`, member, true),
      { params: Promise.resolve({ id: prodId, wikiId: nodeId }) });
    expect(res.status).toBe(403);
    expect(res.headers.get("content-type")).toContain("application/json");
  });

  it("POST presence → 403", async () => {
    const res = await presencePOST(
      makeReq("POST", `/api/production/${prodId}/wiki/${nodeId}/presence`, member, true,
        { clientId: "c1", blockIndex: 0 }),
      { params: Promise.resolve({ id: prodId, wikiId: nodeId }) });
    expect(res.status).toBe(403);
  });

  it("PUT share → 404", async () => {
    const res = await sharePUT(
      makeReq("PUT", `/api/production/${prodId}/wiki/${nodeId}/share`, member, true,
        { addPerson: { userId: member, level: "view" } }),
      { params: Promise.resolve({ id: prodId, wikiId: nodeId }) });
    expect(res.status).toBe(404);
  });
});

describe("前端同源（棘轮）", () => {
  it("AppShell 的「当前文档」提取器过同一道闸", async () => {
    const { readFileSync } = await import("fs");
    const src = readFileSync("components/AppShell.tsx", "utf8");
    expect(src).toContain(`import { isWikiId } from "@/lib/wiki/id"`);
    // 提取器体内必须出现 isWikiId——裸 `return m ? m[1] : null` 就是 #476 的原样。
    const body = src.slice(src.indexOf("function extractCurrentWikiId"));
    const fnBody = body.slice(0, body.indexOf("\n}\n"));
    expect(fnBody).toMatch(/isWikiId\(/);
  });
});
