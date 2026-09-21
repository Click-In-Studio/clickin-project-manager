/**
 * #604 第二批配套：`app/api/production/[id]/**` 45 个路由的手写旁路链全部改走
 * `hasEffectiveGrant(permCtx, …)`。本文件挑四种改法各打一条真路由，钉住两个边界：
 *   - owner 非成员、零 grant 行 → 过门（漏 owner 的原病：接口通页面拒 / 入口不亮）；
 *   - 普通成员只持单枚键 → 那枚过、邻键 403（旁路不得泛化）。
 *
 * 四种改法：
 *   ① `!access || !(admin || owner || await hasGrant)`         → announcements POST
 *   ② `!(owner || (admin && memberPermissions===null) || …)`  → production PATCH name
 *   ③ `!admin && !owner && !await hasGrant`                    → tag-groups POST
 *   ④ 三元 / OR 链里的裸调用                                    → roles POST（requireGate 三元）
 *                                                                  resource-approvers GET（canView 链）
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { makeProduction, cleanupProduction, shortId } from "../_support/factories";
import { upsertFeishuUser, addProductionMember } from "@/lib/db";
import { createSession, SESSION_COOKIE } from "@/lib/account/session";
import { getPool } from "@/lib/pg";
import { POST as postAnnouncement } from "@/app/api/production/[id]/announcements/route";
import { PATCH as patchProduction } from "@/app/api/production/[id]/route";
import { POST as postTagGroup } from "@/app/api/production/[id]/tag-groups/route";
import { POST as postRole } from "@/app/api/production/[id]/roles/route";
import { GET as getApprovers } from "@/app/api/production/[id]/resource-approvers/route";

let prodId: string;
let ownerId: string;
let memberId: string;

const ctx = () => ({ params: Promise.resolve({ id: prodId }) });

function req(path: string, userId: string, method: "GET" | "POST" | "PATCH", body?: unknown): NextRequest {
  return new NextRequest(`http://localhost/api/production/${prodId}${path}`, {
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

beforeAll(async () => {
  ownerId = (await upsertFeishuUser(`test-open-${shortId()}`, `owner${shortId()}`, null, false)).userId;
  memberId = (await upsertFeishuUser(`test-open-${shortId()}`, `member${shortId()}`, null, false)).userId;
  ({ prodId } = await makeProduction(ownerId));
  // owner 刻意不进 production_member
  await getPool().query("DELETE FROM production_member WHERE production_id = $1 AND user_id = $2", [prodId, ownerId]);
  await addProductionMember(prodId, memberId);
});

afterAll(async () => {
  await cleanupProduction(prodId).catch(() => {});
});

describe("owner 非成员、零 grant 行：四种改法的路由全部过门", () => {
  it("① announcements POST", async () => {
    const res = await postAnnouncement(req("/announcements", ownerId, "POST", { title: "t", content: "c" }), ctx());
    expect(res.status).toBe(201);
  });
  it("② production PATCH name", async () => {
    const res = await patchProduction(req("", ownerId, "PATCH", { name: `n${shortId()}` }), ctx());
    expect(res.status).toBe(200);
  });
  it("③ tag-groups POST", async () => {
    const res = await postTagGroup(req("/tag-groups", ownerId, "POST", { name: "g", type: "exclusive" }), ctx());
    expect(res.status).not.toBe(403);
  });
  it("④ roles POST / resource-approvers GET", async () => {
    expect((await postRole(req("/roles", ownerId, "POST", { name: `r${shortId()}` }), ctx())).status).toBe(201);
    const res = await getApprovers(req("/resource-approvers", ownerId, "GET"), ctx());
    expect(res.status).toBe(200);
    expect((await res.json()).canEdit).toBe(true);
  });
});

describe("普通成员只持单枚键：那枚过、邻键 403", () => {
  it("零行时四条路由全 403（门没被旁路撑开）", async () => {
    expect((await postAnnouncement(req("/announcements", memberId, "POST", { title: "t", content: "c" }), ctx())).status).toBe(403);
    expect((await patchProduction(req("", memberId, "PATCH", { name: "x" }), ctx())).status).toBe(403);
    expect((await postTagGroup(req("/tag-groups", memberId, "POST", { name: "g", type: "exclusive" }), ctx())).status).toBe(403);
    expect((await postRole(req("/roles", memberId, "POST", { name: "r" }), ctx())).status).toBe(403);
    expect((await getApprovers(req("/resource-approvers", memberId, "GET"), ctx())).status).toBe(403);
  });

  it("持 announcement@create：只有 announcements POST 亮", async () => {
    await giveRow(memberId, "announcement", "*", "create");
    expect((await postAnnouncement(req("/announcements", memberId, "POST", { title: "t", content: "c" }), ctx())).status).toBe(201);
    expect((await postTagGroup(req("/tag-groups", memberId, "POST", { name: "g", type: "exclusive" }), ctx())).status).toBe(403);
  });

  it("持 production/meta/name@edit：改名过、改描述 403", async () => {
    await giveRow(memberId, "production", "meta/name", "edit");
    expect((await patchProduction(req("", memberId, "PATCH", { name: `n${shortId()}` }), ctx())).status).toBe(200);
    expect((await patchProduction(req("", memberId, "PATCH", { description: "d" }), ctx())).status).toBe(403);
  });

  it("持 production/grants@view：approvers 可看不可编", async () => {
    await giveRow(memberId, "production", "grants", "view");
    const res = await getApprovers(req("/resource-approvers", memberId, "GET"), ctx());
    expect(res.status).toBe(200);
    expect((await res.json()).canEdit).toBe(false);
    expect((await postRole(req("/roles", memberId, "POST", { name: "r" }), ctx())).status).toBe(403);
  });
});
