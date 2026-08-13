import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { createSession, SESSION_COOKIE } from "@/lib/session";
import { getPool } from "@/lib/pg";
import { makeProduction, cleanupProduction, shortId } from "./factories";
import { POST as createAnnouncement } from "@/app/api/production/[id]/announcements/route";
import { POST as createMilestone } from "@/app/api/production/[id]/milestones/route";
import { POST as createCharacter } from "@/app/api/production/[id]/characters/route";
import { PATCH as patchAsset } from "@/app/api/production/[id]/assets/[assetId]/route";
import { createAsset } from "@/lib/asset-db";

// owner 代码级旁路回归（PR #228，用户定谳：owner 全权=身份事实非数据行）。
// owner **无任何 role/区间/行** 也必须通过普通门——四个代表样本覆盖
// 88 处机械修补的四种形态（announcement/milestone=治理普通门、character=E1 结构门、
// asset PATCH=session 变体门）。

async function newUser(): Promise<string> {
  const res = await getPool().query<{ id: string }>("INSERT INTO app_user DEFAULT VALUES RETURNING id");
  return res.rows[0].id;
}

function req(url: string, opts: { session?: string; method?: string; body?: string } = {}): NextRequest {
  const headers = new Headers();
  if (opts.session) headers.set("cookie", `${SESSION_COOKIE}=${opts.session}`);
  if (opts.body) headers.set("content-type", "application/json");
  return new NextRequest(`http://localhost${url}`, { method: opts.method, body: opts.body, headers });
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function ctx(params: Record<string, string>): any {
  return { params: Promise.resolve(params) };
}

let prodId: string;
let owner: string;
let ownerToken: string;

beforeAll(async () => {
  owner = await newUser();
  ({ prodId } = await makeProduction());
  // owner 身份 + 成员（零角色零行零区间）
  await getPool().query("UPDATE production SET owner_id = $1 WHERE id = $2", [owner, prodId]);
  await getPool().query(
    "INSERT INTO production_member (production_id, user_id, roles) VALUES ($1, $2, '{}') ON CONFLICT DO NOTHING",
    [prodId, owner]);
  ownerToken = createSession({ userId: owner, name: "剧组所有者", avatarUrl: null, isAdmin: false });
});

afterAll(async () => {
  await cleanupProduction(prodId).catch(() => {});
});

describe("owner 无任何行仍通过普通门", () => {
  it("announcement 创建（治理域普通门）", async () => {
    const res = await createAnnouncement(
      req(`/api/production/${prodId}/announcements`, {
        method: "POST", session: ownerToken,
        body: JSON.stringify({ title: "owner 旁路", content: "test" }),
      }), ctx({ id: prodId }));
    expect(res.status).toBeLessThan(403);
  });

  it("milestone 创建", async () => {
    const res = await createMilestone(
      req(`/api/production/${prodId}/milestones`, {
        method: "POST", session: ownerToken,
        body: JSON.stringify({ name: "owner 里程碑", endDate: "2027-01-01" }),
      }), ctx({ id: prodId }));
    expect(res.status).toBeLessThan(403);
  });

  it("character 创建（E1 结构域门）", async () => {
    const res = await createCharacter(
      req(`/api/production/${prodId}/characters`, {
        method: "POST", session: ownerToken,
        body: JSON.stringify({ name: `角色${shortId()}` }),
      }), ctx({ id: prodId }));
    expect(res.status).toBeLessThan(403);
  });

  it("asset PATCH（session 变体门 + fails-closed permCtx）", async () => {
    const { asset } = await createAsset({
      productionId: prodId, uploaderUserId: owner, assetType: "reference",
      fileName: "o.pdf", mimeType: "application/pdf",
      isUniversal: true, storageType: "r2",
    });
    // 抹掉创建者行集——owner 必须纯靠旁路通过
    await getPool().query(
      "DELETE FROM production_member_grant WHERE user_id = $1 AND resource_type = 'asset'", [owner]);
    const res = await patchAsset(
      req(`/api/production/${prodId}/assets/${asset.id}`, {
        method: "PATCH", session: ownerToken,
        body: JSON.stringify({ name: "改名" }),
      }), ctx({ id: prodId, assetId: asset.id }));
    expect(res.status).toBeLessThan(403);
  });
});
