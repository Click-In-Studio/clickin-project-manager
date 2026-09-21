/**
 * #604 第三批配套：`app/api/script/[id]/**` 六条路由与 `app/production/[id]/**` 十四个页面
 * 的手写旁路链改走 `hasEffectiveGrant` 族。路由直接打 handler，钉住两个边界：
 *   - owner 非成员、零 grant 行 → 读门 / 写门 / 逐键循环全部过（漏 owner 的原病）；
 *   - 普通成员只持单枚键 → 只有那枚亮（`blocks@view` 过读门、进不了写门；
 *     PATCH 的逐键循环里只持 `blocks@edit` 能插块、不能改角色）。
 * 页面（server component）不在 vitest 里渲染；它们用的是同一条
 * `getProductionPermissionContext → hasEffectiveGrant / hasAnyEffectiveGrant` 链，
 * 边界由 `admin-pages-effective-gate.test.ts` 与本文件共同钉住。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { makeProduction, cleanupProduction, shortId } from "../_support/factories";
import { upsertFeishuUser } from "@/lib/account/db-feishu";
import { addProductionMember } from "@/lib/perm/member-db";
import { getActiveVersionId } from "@/lib/script/version-db";
import { createSession, SESSION_COOKIE } from "@/lib/account/session";
import { getPool } from "@/lib/pg";
import { GET as getScript, PATCH as patchScript } from "@/app/api/script/[id]/route";
import { GET as getBlockTags, PATCH as patchBlockTags } from "@/app/api/script/[id]/block-tags/route";
import { GET as getPages } from "@/app/api/script/[id]/pages/route";

let prodId: string;
let versionId: string;
let ownerId: string;
let memberId: string;

const ctx = () => ({ params: Promise.resolve({ id: prodId }) });

function req(path: string, userId: string, method: "GET" | "PATCH", body?: unknown): NextRequest {
  return new NextRequest(`http://localhost/api/script/${prodId}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Cookie: `${SESSION_COOKIE}=${createSession({ userId, name: "测试", avatarUrl: null, isAdmin: false })}`,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function giveRow(userId: string, type: string, sub: string, verb: string): Promise<void> {
  await getPool().query(
    `INSERT INTO production_member_grant
       (production_id, user_id, resource_type, resource_id, resource_sub, permission_level, grant_source, confirmed_by)
     VALUES ($1, $2, $3, '*', $4, $5, 'direct', $2)`,
    [prodId, userId, type, sub, verb],
  );
}

const insertBlock = () => ({
  clientSeq: 1,
  blockOps: [{
    op: "insert",
    block: { id: `blk_${shortId()}`, type: "stage", content: "", characterIds: [], characterAnnotations: {}, lyric: false, sceneId: null, rehearsalMark: null },
    afterId: null,
  }],
  charOps: [],
  sceneOps: [],
});

const upsertChar = () => ({
  clientSeq: 1,
  blockOps: [],
  charOps: [{ op: "upsert", char: { id: `chr_${shortId()}`, name: "甲", isAggregate: false } }],
  sceneOps: [],
});

beforeAll(async () => {
  ownerId = (await upsertFeishuUser(`test-open-${shortId()}`, `owner${shortId()}`, null, false)).userId;
  memberId = (await upsertFeishuUser(`test-open-${shortId()}`, `member${shortId()}`, null, false)).userId;
  ({ prodId } = await makeProduction(ownerId));
  versionId = (await getActiveVersionId(prodId))!;
  // owner 刻意不进 production_member
  await getPool().query("DELETE FROM production_member WHERE production_id = $1 AND user_id = $2", [prodId, ownerId]);
  await addProductionMember(prodId, memberId);
});

afterAll(async () => {
  await cleanupProduction(prodId).catch(() => {});
});

describe("owner 非成员、零 grant 行", () => {
  it("读门：GET script / block-tags / pages 全过", async () => {
    expect((await getScript(req(`?v=${versionId}`, ownerId, "GET"), ctx())).status).toBe(200);
    expect((await getBlockTags(req("/block-tags", ownerId, "GET"), ctx())).status).toBe(200);
    expect((await getPages(req("/pages", ownerId, "GET"), ctx())).status).not.toBe(403);
  });
  it("写门：PATCH 逐键循环（blocks@edit + character@edit）全过", async () => {
    expect((await patchScript(req(`?v=${versionId}`, ownerId, "PATCH", insertBlock()), ctx())).status).toBe(200);
    expect((await patchScript(req(`?v=${versionId}`, ownerId, "PATCH", upsertChar()), ctx())).status).toBe(200);
  });
});

describe("普通成员只持单枚键", () => {
  it("零行：读门 403", async () => {
    expect((await getScript(req(`?v=${versionId}`, memberId, "GET"), ctx())).status).toBe(403);
    expect((await getBlockTags(req("/block-tags", memberId, "GET"), ctx())).status).toBe(403);
  });

  it("持 blocks@view：读门过、block-tags 写门 403、PATCH 插块 403", async () => {
    await giveRow(memberId, "script", "blocks", "view");
    expect((await getScript(req(`?v=${versionId}`, memberId, "GET"), ctx())).status).toBe(200);
    expect((await getBlockTags(req("/block-tags", memberId, "GET"), ctx())).status).toBe(200);
    expect((await patchBlockTags(req("/block-tags", memberId, "PATCH", { blockId: "x", groupId: "g", optionId: null }), ctx())).status).toBe(403);
    const res = await patchScript(req(`?v=${versionId}`, memberId, "PATCH", insertBlock()), ctx());
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toMatch(/node:script\/\*\/blocks@edit/);
  });

  it("再持 blocks@edit：插块过、改角色仍 403（逐键循环没被旁路撑开）", async () => {
    await giveRow(memberId, "script", "blocks", "edit");
    expect((await patchScript(req(`?v=${versionId}`, memberId, "PATCH", insertBlock()), ctx())).status).toBe(200);
    const res = await patchScript(req(`?v=${versionId}`, memberId, "PATCH", upsertChar()), ctx());
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toMatch(/node:character/);
  });
});
