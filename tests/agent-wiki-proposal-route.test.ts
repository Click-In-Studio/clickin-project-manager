import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "@/app/api/agent/wiki-proposal/route";
import { createSession, SESSION_COOKIE } from "@/lib/session";
import { makeProduction, cleanupProduction, shortId } from "./factories";
import { upsertFeishuUser, addProductionMember } from "@/lib/db";
import { getPool } from "@/lib/pg";
import { createWiki } from "@/lib/wiki-db";
import { insertWikiProposal } from "@/lib/wiki-proposal-db";

// AI review #249 finding 1 回归锁定：/api/agent/wiki-proposal 不能无脑
// getWiki(parentWikiId) 暴露父文档标题——proposeId 关联的 parentWikiId
// 未必是发起者当前真能看到的文档（权限可能已收回，或模型填了个它拿到过
// 但发起者本人无权限的 id），必须过 canViewWiki 门。

let prodId: string;
let ownerId: string;
let memberId: string;
let privateDocId: string;

async function giveWikiCreateGrant(userId: string) {
  await getPool().query(
    `INSERT INTO production_member_grant (production_id, user_id, resource_type, resource_id, resource_sub, permission_level, grant_source)
     VALUES ($1, $2, 'wiki', '*', '*', 'create', 'auto')
     ON CONFLICT (production_id, user_id, resource_type, resource_id, resource_sub, permission_level)
       WHERE is_revoked = false DO NOTHING`,
    [prodId, userId],
  );
}

function makeReq(userId: string, toolCallId: string): NextRequest {
  const cookie = `${SESSION_COOKIE}=${createSession({ userId, name: "测试", avatarUrl: null, isAdmin: false })}`;
  const url = `http://localhost/api/agent/wiki-proposal?productionId=${prodId}&toolCallId=${encodeURIComponent(toolCallId)}`;
  return new NextRequest(url, { headers: { Cookie: cookie } });
}

beforeAll(async () => {
  ownerId = (await upsertFeishuUser(`test-open-${shortId()}`, `路由测试所有者${shortId()}`, null, false)).userId;
  memberId = (await upsertFeishuUser(`test-open-${shortId()}`, `路由测试成员${shortId()}`, null, false)).userId;
  ({ prodId } = await makeProduction(ownerId));
  await addProductionMember(prodId, memberId);
  // memberId 只给 create 权限，不给这篇私有文档的 view——刻意制造
  // "能建文档、但看不见这个父文档" 的场景
  await giveWikiCreateGrant(memberId);

  const priv = await createWiki({ productionId: prodId, title: "路由测试私有父文档", createdBy: ownerId });
  privateDocId = priv.id;
});

afterAll(async () => {
  await cleanupProduction(prodId).catch(() => {});
});

describe("GET /api/agent/wiki-proposal：parentTitle 过可见性门", () => {
  it("发起者对父文档没有 view 权限 → parentTitle 为 null，不泄露标题", async () => {
    const toolCallId = `call_${shortId()}`;
    await insertWikiProposal({
      productionId: prodId, toolCallId, proposedBy: memberId, parentWikiId: privateDocId,
      title: "子文档", body: "", summary: "",
      hasPermission: true, permissionKey: "node:wiki/*@create",
    });

    const res = await GET(makeReq(memberId, toolCallId));
    expect(res.status).toBe(200);
    const data = (await res.json()) as { parentTitle: string | null };
    expect(data.parentTitle).toBeNull();
  });

  it("发起者对父文档有 view 权限（owner）→ 正常返回标题", async () => {
    const toolCallId = `call_${shortId()}`;
    await insertWikiProposal({
      productionId: prodId, toolCallId, proposedBy: ownerId, parentWikiId: privateDocId,
      title: "子文档", body: "", summary: "",
      hasPermission: true, permissionKey: "node:wiki/*@create",
    });

    const res = await GET(makeReq(ownerId, toolCallId));
    expect(res.status).toBe(200);
    const data = (await res.json()) as { parentTitle: string | null };
    expect(data.parentTitle).toBe("路由测试私有父文档");
  });

  it("未登录 → 401；找不到该 proposal（非本人发起）→ 404", async () => {
    const anon = new NextRequest(`http://localhost/api/agent/wiki-proposal?productionId=${prodId}&toolCallId=x`);
    expect((await GET(anon)).status).toBe(401);

    const outsiderId = (await upsertFeishuUser(`test-open-${shortId()}`, `路由测试局外人${shortId()}`, null, false)).userId;
    const toolCallId = `call_${shortId()}`;
    await insertWikiProposal({
      productionId: prodId, toolCallId, proposedBy: ownerId, parentWikiId: null,
      title: "不是你的提议", body: "", summary: "",
      hasPermission: true, permissionKey: "node:wiki/*@create",
    });
    const res = await GET(makeReq(outsiderId, toolCallId));
    expect(res.status).toBe(404);
  });
});
