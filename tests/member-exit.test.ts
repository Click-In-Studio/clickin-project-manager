/**
 * 成员退出状态机（#141）。
 *
 * 钉住的是这套设计里最容易被后来的改动悄悄破坏的四条：
 *   1. 闸门真的关着 —— suspended 拿不到权限上下文（此前 status 根本没人看，
 *      「停用」只是名册上的一条删除线）
 *   2. suspended 是冻结不是撤销 —— 授权行原样保留，复职零重配
 *   3. exited 才真撤，且成员行留着（署名与历史要可追溯）
 *   4. 退出过的人能被重新邀请回来 —— ON CONFLICT DO NOTHING 会让这条静默失效
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { makeProduction, cleanupProduction, shortId } from "./factories";
import {
  upsertFeishuUser,
  addProductionMember,
  getProductionPermissionContext,
} from "@/lib/db";
import {
  selfExitMember,
  suspendMember,
  restoreMember,
  confirmMemberExit,
  recordMemberExitStance,
  getMemberStatus,
  listMemberStatusAudit,
  listSuspendedMembers,
} from "@/lib/member-status";
import { resolveExitHandlers } from "@/lib/member-exit-routing";
import { hasGrant } from "@/lib/grant-check";
import { getPool } from "@/lib/pg";

let prodId: string;
let ownerId: string;
let memberId: string;

/** 给成员发一条可观测的授权行，用来区分「冻结」与「撤销」。 */
async function giveGrant(userId: string) {
  await getPool().query(
    `INSERT INTO production_member_grant
       (production_id, user_id, resource_type, resource_id, resource_sub,
        permission_level, grant_source, confirmed_by)
     VALUES ($1, $2, 'task', '*', '*', 'view', 'self_confirmed', $2)`,
    [prodId, userId],
  );
}

beforeAll(async () => {
  ownerId = (await upsertFeishuUser(`test-open-${shortId()}`, `退出owner${shortId()}`, null, false)).userId;
  memberId = (await upsertFeishuUser(`test-open-${shortId()}`, `退出成员${shortId()}`, null, false)).userId;
  ({ prodId } = await makeProduction(ownerId));
  await addProductionMember(prodId, ownerId);
  await addProductionMember(prodId, memberId);
  await giveGrant(memberId);
});

afterAll(async () => {
  await cleanupProduction(prodId).catch(() => {});
});

describe("自助退出", () => {
  it("active → suspended，成因 self，留一条审计行", async () => {
    expect((await getMemberStatus(prodId, memberId))?.status).toBe("active");

    const res = await selfExitMember(prodId, memberId, "档期结束");
    expect(res.ok).toBe(true);

    const after = await getMemberStatus(prodId, memberId);
    expect(after?.status).toBe("suspended");
    expect(after?.statusSource).toBe("self");
    expect(after?.statusChangedAt).not.toBeNull();

    const audit = await listMemberStatusAudit(prodId, memberId);
    expect(audit[0].action).toBe("self_exit");
    expect(audit[0].fromStatus).toBe("active");
    expect(audit[0].toStatus).toBe("suspended");
    expect(audit[0].note).toBe("档期结束");
  });

  it("闸门真的关着：suspended 拿不到权限上下文", async () => {
    expect(await getProductionPermissionContext(memberId, false, prodId)).toBeNull();
  });

  it("但那是冻结不是撤销：授权行原样保留", async () => {
    const { rows } = await getPool().query<{ is_revoked: boolean }>(
      `SELECT is_revoked FROM production_member_grant
        WHERE production_id = $1 AND user_id = $2`,
      [prodId, memberId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].is_revoked).toBe(false);
  });

  it("挂在 owner 的待处理清单上", async () => {
    const pending = await listSuspendedMembers(prodId);
    expect(pending.map((p) => p.userId)).toContain(memberId);
    expect(pending.find((p) => p.userId === memberId)?.statusSource).toBe("self");
  });

  it("重复退出打空——状态不对，而不是覆盖", async () => {
    const again = await selfExitMember(prodId, memberId);
    expect(again).toEqual({ ok: false, reason: "wrong_status" });
  });
});

describe("表态", () => {
  it("不认可只写审计行，不动状态", async () => {
    const res = await recordMemberExitStance(prodId, memberId, ownerId, "object", "还没交接");
    expect(res.ok).toBe(true);

    expect((await getMemberStatus(prodId, memberId))?.status).toBe("suspended");

    const audit = await listMemberStatusAudit(prodId, memberId);
    expect(audit[0].action).toBe("object");
    expect(audit[0].toStatus).toBeNull();
    expect(audit[0].actorId).toBe(ownerId);
  });
});

describe("复职", () => {
  it("suspended → active，成因清空，授权原样生效（零重配）", async () => {
    const res = await restoreMember(prodId, memberId, ownerId);
    expect(res.ok).toBe(true);

    const after = await getMemberStatus(prodId, memberId);
    expect(after?.status).toBe("active");
    expect(after?.statusSource).toBeNull();
    expect(after?.statusChangedBy).toBe(ownerId);

    // 闸门重新打开，且此前那条 task@view 不需要重新配
    expect(await getProductionPermissionContext(memberId, false, prodId)).not.toBeNull();
    expect(await hasGrant(memberId, prodId, "task", "*", "*", "view")).toBe(true);
  });

  it("active 不能再复职一次", async () => {
    expect(await restoreMember(prodId, memberId, ownerId)).toEqual({
      ok: false,
      reason: "wrong_status",
    });
  });
});

describe("确认离组", () => {
  it("必须先经 suspended：active 不能直接 exited", async () => {
    expect(await confirmMemberExit(prodId, memberId, ownerId)).toEqual({
      ok: false,
      reason: "wrong_status",
    });
  });

  it("suspended → exited：授权真撤，成员行留着", async () => {
    expect((await suspendMember(prodId, memberId, ownerId)).ok).toBe(true);
    expect((await getMemberStatus(prodId, memberId))?.statusSource).toBe("admin");

    const res = await confirmMemberExit(prodId, memberId, ownerId, "合同到期");
    expect(res.ok).toBe(true);

    const after = await getMemberStatus(prodId, memberId);
    // 成员行没被删——署名、工时、审批痕迹都还能追溯到这个人
    expect(after).not.toBeNull();
    expect(after?.status).toBe("exited");
    // 成因沿用：确认只是定性，不改变当初是谁发起的
    expect(after?.statusSource).toBe("admin");

    expect(await hasGrant(memberId, prodId, "task", "*", "*", "view")).toBe(false);
    const { rows } = await getPool().query<{ is_revoked: boolean; revoked_reason: string }>(
      `SELECT is_revoked, revoked_reason FROM production_member_grant
        WHERE production_id = $1 AND user_id = $2`,
      [prodId, memberId],
    );
    expect(rows[0].is_revoked).toBe(true);
    expect(rows[0].revoked_reason).toBe("member_removed");
  });

  it("已离组的人不在名册的默认口径里", async () => {
    const pending = await listSuspendedMembers(prodId);
    expect(pending.map((p) => p.userId)).not.toContain(memberId);
  });
});

describe("重新入组", () => {
  it("exited 的人能被重新邀请回来——行复活为 active，并留一条审计", async () => {
    await addProductionMember(prodId, memberId);

    const after = await getMemberStatus(prodId, memberId);
    expect(after?.status).toBe("active");
    expect(after?.statusSource).toBeNull();

    const audit = await listMemberStatusAudit(prodId, memberId);
    expect(audit[0].action).toBe("restore");
    expect(audit[0].fromStatus).toBe("exited");

    // 回来是新 membership：旧授权在确认离组时已撤，不会借尸还魂
    expect(await hasGrant(memberId, prodId, "task", "*", "*", "view")).toBe(false);
  });

  it("对已在职成员重复调用不写审计行", async () => {
    const before = (await listMemberStatusAudit(prodId, memberId)).length;
    await addProductionMember(prodId, memberId);
    expect((await listMemberStatusAudit(prodId, memberId)).length).toBe(before);
  });
});

describe("owner 保护", () => {
  it("owner 退不了、也停不了——要走必须先转移 owner", async () => {
    expect(await selfExitMember(prodId, ownerId)).toEqual({
      ok: false,
      reason: "owner_protected",
    });
    expect(await suspendMember(prodId, ownerId, ownerId)).toEqual({
      ok: false,
      reason: "owner_protected",
    });
    expect((await getMemberStatus(prodId, ownerId))?.status).toBe("active");
  });
});

describe("席位", () => {
  it("suspended 占席位，exited 不占", async () => {
    const { seatsFullForNewMember, PRODUCTION_TIERS } = await import("@/lib/plan");
    const limit = PRODUCTION_TIERS.free.seatLimit;
    const owner3 = (await upsertFeishuUser(`test-open-${shortId()}`, `席位owner${shortId()}`, null, false)).userId;
    const { prodId: prod3 } = await makeProduction(owner3);
    const client = await getPool().connect();
    try {
      // 免费档席位打满：owner 已占一席，再补到 limit
      const extras: string[] = [];
      for (let i = 0; i < limit - 1; i++) {
        const u = (await upsertFeishuUser(`test-open-${shortId()}`, `席位${i}${shortId()}`, null, false)).userId;
        extras.push(u);
        await addProductionMember(prod3, u);
      }
      expect(await seatsFullForNewMember(client, prod3)).toBe(true);

      // 停用不释放席位——授权还冻着、随时可复职，位子得留着
      expect((await suspendMember(prod3, extras[0], owner3)).ok).toBe(true);
      expect(await seatsFullForNewMember(client, prod3)).toBe(true);

      // 确认离组才释放
      expect((await confirmMemberExit(prod3, extras[0], owner3)).ok).toBe(true);
      expect(await seatsFullForNewMember(client, prod3)).toBe(false);
    } finally {
      client.release();
      await cleanupProduction(prod3).catch(() => {});
    }
  });
});

describe("账号合并", () => {
  it("状态与轨迹跟着身份走，合并不会把已离组的人悄悄复活", async () => {
    // 合并要求两个账号无共同项目，故另起一个演出
    const { mergeAccounts } = await import("@/lib/db");
    const keep = (await upsertFeishuUser(`test-open-${shortId()}`, `留存${shortId()}`, null, false)).userId;
    const del = (await upsertFeishuUser(`test-open-${shortId()}`, `待并${shortId()}`, null, false)).userId;
    const owner2 = (await upsertFeishuUser(`test-open-${shortId()}`, `并owner${shortId()}`, null, false)).userId;
    const { prodId: prod2 } = await makeProduction(owner2);

    try {
      await addProductionMember(prod2, del);
      expect((await selfExitMember(prod2, del, "并账号前退出")).ok).toBe(true);
      expect((await confirmMemberExit(prod2, del, owner2)).ok).toBe(true);

      await mergeAccounts(keep, del);

      // 漏搬 status 三列的话，DEFAULT 'active' 会让这个人在合并后凭空复活
      const merged = await getMemberStatus(prod2, keep);
      expect(merged?.status).toBe("exited");
      expect(merged?.statusSource).toBe("self");

      // 轨迹改指向而不是被级联删掉——否则合并账号就是抹痕迹的第二条路
      const audit = await listMemberStatusAudit(prod2, keep);
      expect(audit.map((a) => a.action)).toEqual(
        expect.arrayContaining(["self_exit", "confirm_exit"]),
      );
    } finally {
      await cleanupProduction(prod2).catch(() => {});
      await getPool().query("DELETE FROM app_user WHERE id = ANY($1::uuid[])", [[keep, del, owner2]])
        .catch(() => {});
    }
  });
});

describe("处置链路由", () => {
  it("owner 兜底在列，退出者本人不在列", async () => {
    const handlers = await resolveExitHandlers(prodId, memberId);
    expect(handlers.map((h) => h.userId)).toContain(ownerId);
    expect(handlers.map((h) => h.userId)).not.toContain(memberId);
    // owner 必然能终局
    expect(handlers.find((h) => h.userId === ownerId)?.canFinalize).toBe(true);
  });

  it("直属上级排在 owner 前面，但不持 member 门就只能表态", async () => {
    const supId = (await upsertFeishuUser(`test-open-${shortId()}`, `上级${shortId()}`, null, false)).userId;
    await addProductionMember(prodId, supId);
    await getPool().query(
      "UPDATE production_member SET supervisor_id = $3 WHERE production_id = $1 AND user_id = $2",
      [prodId, memberId, supId],
    );

    const handlers = await resolveExitHandlers(prodId, memberId);
    expect(handlers[0].userId).toBe(supId);
    expect(handlers[0].stage).toBe("supervisor");
    // supervisor_id 只是数据字段，本身不携带任何权限
    expect(handlers[0].canFinalize).toBe(false);
    expect(handlers.find((h) => h.userId === ownerId)?.canFinalize).toBe(true);

    await getPool().query(
      "UPDATE production_member SET supervisor_id = NULL WHERE production_id = $1 AND user_id = $2",
      [prodId, memberId],
    );
  });
});
