/**
 * 等级体系（#280，db/add-plan.sql）：
 *   层 1 建项目门 —— user_plan 无行 403 / creator free / internal 直落最高档 / 配额
 *   层 2 兑换码 —— 只升不降、过期/用尽/错类不消耗、特邀豁免落库
 *   层 3 座位上限 —— acceptInvite 事务内按档位拦 seats_full，升档后放行
 *   层 4 功能门 —— requireProductionFeature 独立于 grant 判定
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { createSession, SESSION_COOKIE } from "@/lib/session";
import { upsertFeishuUser, deleteProduction, createProduction, ProductionQuotaError } from "@/lib/db";
import { createInvite, acceptInvite } from "@/lib/invite-db";
import {
  getUserTier, getProductionPlan, redeemPlanCode, requireProductionFeature,
  productionFeatureAllowed, PRODUCTION_TIERS, USER_TIERS,
} from "@/lib/plan";
import { makeProduction, cleanupProduction, shortId } from "./factories";
import { getPool } from "@/lib/pg";
import { POST as createProductionHandler } from "@/app/api/productions/route";
import { POST as accountRedeemHandler } from "@/app/api/account/redeem-code/route";
import { PATCH as memberPermPatch } from "@/app/api/production/[id]/permissions/route";

function req(url: string, opts: { session?: string; method?: string; body?: string } = {}): NextRequest {
  const headers = new Headers();
  if (opts.session) headers.set("cookie", `${SESSION_COOKIE}=${opts.session}`);
  return new NextRequest(`http://localhost${url}`, { method: opts.method, body: opts.body, headers });
}

async function makeUser(tier?: "creator" | "internal"): Promise<{ userId: string; session: string }> {
  const { userId } = await upsertFeishuUser(`test-plan-${shortId()}`, `档位测试用户-${shortId()}`, null, false);
  if (tier) {
    await getPool().query(
      "INSERT INTO user_plan (user_id, tier, source) VALUES ($1, $2, 'test') ON CONFLICT (user_id) DO UPDATE SET tier = $2",
      [userId, tier],
    );
  }
  return { userId, session: createSession({ userId, name: "档位测试用户", avatarUrl: null, isAdmin: false }) };
}

async function makeCode(over: Partial<{
  kind: string; grantsTier: string; grantsExempt: boolean; exemptNote: string | null;
  maxUses: number; usedCount: number; expiresAt: string | null;
}> = {}): Promise<string> {
  const code = `TESTCODE-${shortId()}`;
  await getPool().query(
    `INSERT INTO plan_code (code, kind, grants_tier, grants_exempt, exempt_note, max_uses, used_count, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [code, over.kind ?? "user_upgrade", over.grantsTier ?? "creator", over.grantsExempt ?? false,
     over.exemptNote ?? null, over.maxUses ?? 1, over.usedCount ?? 0, over.expiresAt ?? null],
  );
  return code;
}

const createdProds: string[] = [];
const createdCodes: string[] = [];

afterAll(async () => {
  for (const id of createdProds) await deleteProduction(id).catch(() => {});
  await getPool().query("DELETE FROM plan_code WHERE code = ANY($1)", [createdCodes]).catch(() => {});
});

// ── 层 1：建项目门 ─────────────────────────────────────────────────────────────

describe("建项目门（用户等级）", () => {
  it("creator 用户 → 201，项目为 free（production_plan 无行）", async () => {
    const { session } = await makeUser("creator");
    const res = await createProductionHandler(
      req("/api/productions", { method: "POST", body: JSON.stringify({ name: "creator的项目" }), session }),
    );
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    createdProds.push(id);
    const plan = await getProductionPlan(id);
    expect(plan.tier).toBe("free");
    const rows = await getPool().query("SELECT 1 FROM production_plan WHERE production_id = $1", [id]);
    expect(rows.rows.length).toBe(0);
  });

  it("internal 用户 → 201，项目直落最高档（source=internal_owner）", async () => {
    const { session } = await makeUser("internal");
    const res = await createProductionHandler(
      req("/api/productions", { method: "POST", body: JSON.stringify({ name: "internal的项目" }), session }),
    );
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    createdProds.push(id);
    const row = await getPool().query<{ tier: string; source: string }>(
      "SELECT tier, source FROM production_plan WHERE production_id = $1", [id],
    );
    expect(row.rows[0]?.tier).toBe(USER_TIERS.internal.initialProductionTier);
    expect(row.rows[0]?.source).toBe("internal_owner");
  });

  it("配额硬上限在 createProduction 事务内（并发兜底，#307 review 1）", async () => {
    const { userId } = await makeUser("creator");
    const max = USER_TIERS.creator.maxOwnedProductions;
    for (let i = 0; i < max; i++) {
      const pid = shortId();
      createdProds.push(pid);
      await getPool().query(
        "INSERT INTO production (id, name, owner_id) VALUES ($1, $2, $3)",
        [pid, `硬上限占位${i}`, userId],
      );
    }
    // 绕过路由预检直接调库层：事务内锁 user_plan 行后重判，仍要拒绝
    await expect(
      createProduction(shortId(), "越过预检的项目", userId, undefined, null, undefined, { maxOwned: max }),
    ).rejects.toThrow(ProductionQuotaError);
  });

  it("creator 达到配额上限 → 403", async () => {
    const { userId, session } = await makeUser("creator");
    // 直插 production 行占满配额（不走路由，省模版灌入的开销）
    for (let i = 0; i < USER_TIERS.creator.maxOwnedProductions; i++) {
      const pid = shortId();
      createdProds.push(pid);
      await getPool().query(
        "INSERT INTO production (id, name, owner_id) VALUES ($1, $2, $3)",
        [pid, `配额占位${i}`, userId],
      );
    }
    const res = await createProductionHandler(
      req("/api/productions", { method: "POST", body: JSON.stringify({ name: "超配额" }), session }),
    );
    expect(res.status).toBe(403);
  });
});

// ── 层 2：兑换码 ───────────────────────────────────────────────────────────────

describe("兑换码", () => {
  it("user_upgrade 码：无档 → creator，二次兑换 no_effect 不消耗次数", async () => {
    const { userId } = await makeUser();
    const code = await makeCode({ grantsTier: "creator", maxUses: 5 });
    createdCodes.push(code);

    const r1 = await redeemPlanCode({ code, userId });
    expect(r1).toMatchObject({ ok: true, tier: "creator" });
    expect(await getUserTier(userId)).toBe("creator");

    const r2 = await redeemPlanCode({ code, userId });
    expect(r2).toMatchObject({ ok: false, reason: "no_effect" });
    const uses = await getPool().query<{ used_count: number }>(
      "SELECT used_count FROM plan_code WHERE code = $1", [code],
    );
    expect(uses.rows[0].used_count).toBe(1);
  });

  it("internal 用户兑 creator 码 → no_effect（只升不降）", async () => {
    const { userId } = await makeUser("internal");
    const code = await makeCode({ grantsTier: "creator" });
    createdCodes.push(code);
    expect(await redeemPlanCode({ code, userId })).toMatchObject({ ok: false, reason: "no_effect" });
    expect(await getUserTier(userId)).toBe("internal");
  });

  it("过期 / 用尽 / 错类 / 不存在", async () => {
    const { userId } = await makeUser();
    const { prodId } = await makeProduction(userId);
    createdProds.push(prodId);

    const expired = await makeCode({ expiresAt: "2020-01-01T00:00:00Z" });
    const exhausted = await makeCode({ maxUses: 1, usedCount: 1 });
    const prodCode = await makeCode({ kind: "production_upgrade", grantsTier: "pro" });
    createdCodes.push(expired, exhausted, prodCode);

    expect(await redeemPlanCode({ code: expired, userId })).toMatchObject({ ok: false, reason: "expired" });
    expect(await redeemPlanCode({ code: exhausted, userId })).toMatchObject({ ok: false, reason: "exhausted" });
    // 项目码拿去个人兑 / 个人码拿去项目兑 → wrong_kind
    expect(await redeemPlanCode({ code: prodCode, userId })).toMatchObject({ ok: false, reason: "wrong_kind" });
    const userCode = await makeCode({ grantsTier: "creator" });
    createdCodes.push(userCode);
    expect(await redeemPlanCode({ code: userCode, userId, productionId: prodId })).toMatchObject({ ok: false, reason: "wrong_kind" });
    expect(await redeemPlanCode({ code: "不存在的码", userId })).toMatchObject({ ok: false, reason: "not_found" });
  });

  it("兑换端点限流：窗口内超过尝试上限 → 429（#307 review 2）", async () => {
    const { session } = await makeUser();
    for (let i = 0; i < 10; i++) {
      const res = await accountRedeemHandler(
        req("/api/account/redeem-code", { method: "POST", body: JSON.stringify({ code: `暴破尝试${i}` }), session }),
      );
      expect(res.status).toBe(404);
    }
    const blocked = await accountRedeemHandler(
      req("/api/account/redeem-code", { method: "POST", body: JSON.stringify({ code: "第十一次" }), session }),
    );
    expect(blocked.status).toBe(429);
  });

  it("production_upgrade 码：free → pro；特邀码落 billing_exempt + exempt_note", async () => {
    const { userId } = await makeUser("creator");
    const { prodId } = await makeProduction(userId);
    createdProds.push(prodId);

    const up = await makeCode({ kind: "production_upgrade", grantsTier: "pro" });
    createdCodes.push(up);
    const r1 = await redeemPlanCode({ code: up, userId, productionId: prodId });
    expect(r1).toMatchObject({ ok: true, tier: "pro", billingExempt: false });
    expect((await getProductionPlan(prodId)).tier).toBe("pro");

    // 已是 pro，再兑纯升档码 → no_effect；带豁免的码仍有效果（exemptUp）
    const up2 = await makeCode({ kind: "production_upgrade", grantsTier: "pro" });
    const exempt = await makeCode({ kind: "production_upgrade", grantsTier: "pro", grantsExempt: true, exemptNote: "特邀剧团" });
    createdCodes.push(up2, exempt);
    expect(await redeemPlanCode({ code: up2, userId, productionId: prodId })).toMatchObject({ ok: false, reason: "no_effect" });
    const r3 = await redeemPlanCode({ code: exempt, userId, productionId: prodId });
    expect(r3).toMatchObject({ ok: true, tier: "pro", billingExempt: true });
    const plan = await getProductionPlan(prodId);
    expect(plan.billingExempt).toBe(true);
    expect(plan.exemptNote).toBe("特邀剧团");
  });
});

// ── 层 3：座位上限（acceptInvite 事务内）────────────────────────────────────────

describe("座位上限", () => {
  let prodId = "";
  let ownerId = "";

  beforeAll(async () => {
    ({ userId: ownerId } = await makeUser("creator"));
    ({ prodId } = await makeProduction(ownerId));
    createdProds.push(prodId);
  });

  it("free 档满员 → seats_full；升 pro 后放行", async () => {
    const limit = PRODUCTION_TIERS.free.seatLimit;
    // 填满到上限（makeProduction 已含 owner 一行成员）
    const current = await getPool().query<{ n: string }>(
      "SELECT count(*) AS n FROM production_member WHERE production_id = $1", [prodId],
    );
    for (let i = Number(current.rows[0].n); i < limit; i++) {
      const { userId } = await makeUser();
      await getPool().query(
        "INSERT INTO production_member (production_id, user_id) VALUES ($1, $2)",
        [prodId, userId],
      );
    }

    const { token } = await createInvite({ productionId: prodId, createdBy: ownerId, maxUses: null, expiresInDays: null });
    const { userId: lateComer } = await makeUser();
    const denied = await acceptInvite(token, lateComer);
    expect(denied).toMatchObject({ ok: false, reason: "seats_full" });

    // 升档后同一邀请可接受
    const up = await makeCode({ kind: "production_upgrade", grantsTier: "pro" });
    createdCodes.push(up);
    expect(await redeemPlanCode({ code: up, userId: ownerId, productionId: prodId })).toMatchObject({ ok: true });
    const accepted = await acceptInvite(token, lateComer);
    expect(accepted).toMatchObject({ ok: true, alreadyMember: false });
  });

  afterAll(async () => {
    await cleanupProduction(prodId).catch(() => {});
  });
});

// ── 层 4：功能门 ───────────────────────────────────────────────────────────────

describe("项目功能门", () => {
  it("free 档 AI/高级权限配置关闭 → 403；pro 档放行", async () => {
    const { userId } = await makeUser("creator");
    const { prodId } = await makeProduction(userId);
    createdProds.push(prodId);

    expect(await productionFeatureAllowed(prodId, "ai")).toBe(false);
    const deny = await requireProductionFeature(prodId, "ai");
    expect(deny?.status).toBe(403);
    expect(await productionFeatureAllowed(prodId, "advancedPerms")).toBe(false);

    await getPool().query(
      "INSERT INTO production_plan (production_id, tier, source) VALUES ($1, 'pro', 'test') ON CONFLICT (production_id) DO UPDATE SET tier = 'pro'",
      [prodId],
    );
    expect(await productionFeatureAllowed(prodId, "ai")).toBe(true);
    expect(await requireProductionFeature(prodId, "ai")).toBeNull();
    expect(await productionFeatureAllowed(prodId, "advancedPerms")).toBe(true);
  });

  // 个人区间（production_member_permission）是权限中心三块写入里的第三块。首 PR 只给
  // 角色权限集 / 部门区间加了门，这条补齐——前端「权限中心」整个菜单项按 advancedPerms
  // 显隐，API 不设门的话付费墙只有半截。
  it("个人区间写入同样在高级权限配置门内（free → 403，pro 放行）", async () => {
    const { userId, session } = await makeUser("creator");
    const { prodId } = await makeProduction(userId);
    createdProds.push(prodId);

    const body = JSON.stringify({ userId, permission: "node:script/blocks@edit", granted: true });
    const patch = () =>
      memberPermPatch(
        req(`/api/production/${prodId}/permissions`, { session, method: "PATCH", body }),
        { params: Promise.resolve({ id: prodId }) },
      );

    const denied = await patch();
    expect(denied.status).toBe(403);
    expect((await denied.json()).error).toContain("高级权限配置");

    await getPool().query(
      "INSERT INTO production_plan (production_id, tier, source) VALUES ($1, 'pro', 'test') ON CONFLICT (production_id) DO UPDATE SET tier = 'pro'",
      [prodId],
    );
    expect((await patch()).status).toBe(200);
  });
});
