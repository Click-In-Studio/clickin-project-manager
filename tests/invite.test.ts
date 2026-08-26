import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getPool } from "@/lib/pg";
import {
  createInvite,
  listInvites,
  revokeInvite,
  getInviteInfo,
  acceptInvite,
} from "@/lib/invite-db";
import { createProductionDept } from "@/lib/dept-db";
import { makeProduction, cleanupProduction, shortId } from "./factories";

// #156 邀请制：开放链接/定向邮件、状态派生、接受事务（入组+预配+计数）、防护

let prodId: string;
let inviterId: string;
let deptId: string;

async function newUser(email?: string): Promise<string> {
  const { rows } = await getPool().query<{ id: string }>("INSERT INTO app_user DEFAULT VALUES RETURNING id");
  const id = rows[0].id;
  await getPool().query("INSERT INTO user_profile (user_id, name) VALUES ($1, '受邀者')", [id]);
  if (email) {
    await getPool().query(
      `INSERT INTO user_platform_identity (user_id, platform_id, platform_user_id, is_login_method, is_primary)
       VALUES ($1, 'email', $2, true, true)`,
      [id, email],
    );
  }
  return id;
}

beforeAll(async () => {
  ({ prodId } = await makeProduction());
  inviterId = await newUser();
  const dept = await createProductionDept({ productionId: prodId, name: `邀部${shortId()}` });
  deptId = dept.id;
});

afterAll(async () => {
  await getPool().query("DELETE FROM app_user WHERE id = $1", [inviterId]).catch(() => {});
  await cleanupProduction(prodId).catch(() => {});
});

describe("席位与退出过的人（#141）", () => {
  it("席位满时重新邀请一个 suspended 成员不该被挡——他本来就占着席位", async () => {
    const { PRODUCTION_TIERS } = await import("@/lib/plan");
    const { suspendMember } = await import("@/lib/member-status");
    const { rows: ownerRow } = await getPool().query<{ owner_id: string }>(
      "SELECT owner_id::text AS owner_id FROM production WHERE id = $1",
      [prodId],
    );
    const owner = ownerRow[0].owner_id;

    // 另起一个演出，把席位精确打满
    const { prodId: p } = await makeProduction(owner);
    const joined: string[] = [];
    try {
      for (let i = 0; i < PRODUCTION_TIERS.free.seatLimit - 1; i++) {
        const u = await newUser();
        joined.push(u);
        const { token } = await createInvite({ productionId: p, createdBy: owner });
        expect((await acceptInvite(token, u)).ok).toBe(true);
      }
      // 满员：新人进不来
      const stranger = await newUser();
      joined.push(stranger);
      const t1 = (await createInvite({ productionId: p, createdBy: owner })).token;
      expect(await acceptInvite(t1, stranger)).toEqual({ ok: false, reason: "seats_full" });

      // 停用其中一人——席位不释放（suspended 占席位），但他自己回来不该被自己挡住：
      // 接受邀请后人数一个没变。判据必须是「已占席位」而不是「已是在职成员」。
      expect((await suspendMember(p, joined[0], owner)).ok).toBe(true);
      const t2 = (await createInvite({ productionId: p, createdBy: owner })).token;
      expect(await acceptInvite(t2, joined[0])).toMatchObject({ ok: true, alreadyMember: false });

      const { rows } = await getPool().query<{ status: string }>(
        "SELECT status FROM production_member WHERE production_id = $1 AND user_id = $2",
        [p, joined[0]],
      );
      expect(rows[0].status).toBe("active");

      // 而真正的新人依然进不来——席位确实还是满的
      const t3 = (await createInvite({ productionId: p, createdBy: owner })).token;
      expect(await acceptInvite(t3, stranger)).toEqual({ ok: false, reason: "seats_full" });
    } finally {
      await cleanupProduction(p).catch(() => {});
      await getPool().query("DELETE FROM app_user WHERE id = ANY($1::uuid[])", [joined])
        .catch(() => {});
    }
  });
});

describe("开放链接：接受入组+预配+计数", () => {
  it("接受后成为成员并带预配角色/部门；重复接受幂等（计数仍增）", async () => {
    const joiner = await newUser();
    const { token } = await createInvite({
      productionId: prodId, createdBy: inviterId,
      presetRoles: ["导演"], presetDeptIds: [deptId],
      expiresInDays: 7,
    });
    const res = await acceptInvite(token, joiner);
    expect(res).toEqual({ ok: true, productionId: prodId, alreadyMember: false });

    const pm = await getPool().query<{ roles: string[] }>(
      "SELECT roles FROM production_member WHERE production_id = $1 AND user_id = $2",
      [prodId, joiner],
    );
    expect(pm.rows[0]?.roles).toContain("导演");
    const dm = await getPool().query(
      "SELECT 1 FROM production_dept_member WHERE dept_id = $1 AND user_id = $2",
      [deptId, joiner],
    );
    expect(dm.rows).toHaveLength(1);

    const again = await acceptInvite(token, joiner);
    expect(again).toMatchObject({ ok: true, alreadyMember: true });
    const inv = (await listInvites(prodId)).find(i => i.token === token);
    expect(inv?.usedCount).toBe(2);
    await getPool().query("DELETE FROM app_user WHERE id = $1", [joiner]);
  });

  it("max_uses 用尽 → exhausted；撤销 → revoked；过期 → expired", async () => {
    const a = await newUser();
    const { token } = await createInvite({ productionId: prodId, createdBy: inviterId, maxUses: 1 });
    expect((await acceptInvite(token, a)).ok).toBe(true);
    const b = await newUser();
    expect(await acceptInvite(token, b)).toEqual({ ok: false, reason: "exhausted" });

    const { token: t2 } = await createInvite({ productionId: prodId, createdBy: inviterId });
    expect(await revokeInvite(prodId, t2)).toBe(true);
    expect(await acceptInvite(t2, b)).toEqual({ ok: false, reason: "revoked" });

    const { token: t3 } = await createInvite({ productionId: prodId, createdBy: inviterId });
    await getPool().query(
      "UPDATE production_invite SET expires_at = NOW() - interval '1 hour' WHERE token = $1", [t3]);
    expect(await acceptInvite(t3, b)).toEqual({ ok: false, reason: "expired" });
    expect((await getInviteInfo(t3))?.status).toBe("expired");

    for (const id of [a, b]) await getPool().query("DELETE FROM app_user WHERE id = $1", [id]);
  });
});

describe("定向邮件邀请", () => {
  it("email identity 匹配才能接受；不匹配拒绝", async () => {
    const email = `invitee-${shortId()}@example.com`;
    const right = await newUser(email);
    const wrong = await newUser(`other-${shortId()}@example.com`);
    const { token } = await createInvite({ productionId: prodId, createdBy: inviterId, email });

    expect(await acceptInvite(token, wrong)).toEqual({ ok: false, reason: "email_mismatch" });
    expect((await acceptInvite(token, right)).ok).toBe(true);

    for (const id of [right, wrong]) await getPool().query("DELETE FROM app_user WHERE id = $1", [id]);
  });

  it("getInviteInfo 携带项目名与定向邮箱；未知 token = null", async () => {
    const email = `info-${shortId()}@example.com`;
    const { token } = await createInvite({ productionId: prodId, createdBy: inviterId, email });
    const info = await getInviteInfo(token);
    expect(info?.productionId).toBe(prodId);
    expect(info?.email).toBe(email);
    expect(info?.status).toBe("active");
    expect(await getInviteInfo("00000000-0000-0000-0000-000000000000")).toBeNull();
  });
});

describe("定向三态与认领链接（表格分发批）", () => {
  it("target_user_id 定向：他人接受被拒", async () => {
    const target = await newUser();
    const stranger = await newUser();
    const { token } = await createInvite({ productionId: prodId, createdBy: inviterId, targetUserId: target });
    expect(await acceptInvite(token, stranger)).toEqual({ ok: false, reason: "target_mismatch" });
    expect((await acceptInvite(token, target)).ok).toBe(true);
    for (const id of [target, stranger]) await getPool().query("DELETE FROM app_user WHERE id = $1", [id]);
  });

  it("claim 链接：普通接受被拒（needs_claim）；按名认领入组+行预配；名额不可重复认领", async () => {
    const { createClaimInvite, claimInvite } = await import("@/lib/invite-db");
    const { token } = await createClaimInvite({
      productionId: prodId, createdBy: inviterId,
      entries: [
        { name: "张三", presetRoles: ["导演"], presetDeptIds: [deptId] },
        { name: "李四", presetRoles: [], presetDeptIds: [] },
      ],
    });
    const a = await newUser();
    expect(await acceptInvite(token, a)).toEqual({ ok: false, reason: "needs_claim" });

    const info = await getInviteInfo(token);
    expect(info?.kind).toBe("claim");
    const zhangsan = info!.unclaimed.find(c => c.name === "张三")!;
    expect(info!.unclaimed).toHaveLength(2);

    const res = await claimInvite(token, zhangsan.id, a);
    expect(res).toMatchObject({ ok: true, productionId: prodId });
    const pm = await getPool().query<{ roles: string[] }>(
      "SELECT roles FROM production_member WHERE production_id = $1 AND user_id = $2", [prodId, a]);
    expect(pm.rows[0]?.roles).toContain("导演");

    const b = await newUser();
    expect(await claimInvite(token, zhangsan.id, b)).toEqual({ ok: false, reason: "claim_taken" });
    const info2 = await getInviteInfo(token);
    expect(info2!.unclaimed.map(c => c.name)).toEqual(["李四"]);

    for (const id of [a, b]) await getPool().query("DELETE FROM app_user WHERE id = $1", [id]);
  });
});
