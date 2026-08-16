import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getPool } from "@/lib/pg";
import { listGrantLedger, revokeGrantById } from "@/lib/grant-audit-db";
import { makeProduction, cleanupProduction } from "./factories";

// 管理后台·权限审计：账本筛选、status 派生（active/revoked/expired）、强制撤销

let prodId: string;
let userId: string;
let activeId: string;
let expiredId: string;
let revokedId: string;

beforeAll(async () => {
  ({ prodId } = await makeProduction());
  const u = await getPool().query<{ id: string }>("INSERT INTO app_user DEFAULT VALUES RETURNING id");
  userId = u.rows[0].id;
  await getPool().query(
    "INSERT INTO user_profile (user_id, name) VALUES ($1, '审计对象')", [userId]);

  // 同键活跃行有唯一索引：三行用不同 sub
  const ins = async (sub: string, extra: string) => {
    const { rows } = await getPool().query<{ id: string }>(
      `INSERT INTO production_member_grant
         (production_id, user_id, resource_type, resource_id, resource_sub, permission_level, grant_source${extra ? "," + extra.split("=")[0] : ""})
       VALUES ($1, $2, 'event', '*', $3, 'view', 'direct'${extra ? "," + extra.split("=")[1] : ""})
       RETURNING id`,
      [prodId, userId, sub],
    );
    return rows[0].id;
  };
  activeId = await ins("meta", "");
  expiredId = await ins("details", "expires_at=NOW() - interval '1 hour'");
  revokedId = await ins("call_sheet", "is_revoked=true");
  await getPool().query(
    "UPDATE production_member_grant SET revoked_reason = 'role_change' WHERE id = $1", [revokedId]);
});

afterAll(async () => {
  await getPool().query("DELETE FROM app_user WHERE id = $1", [userId]).catch(() => {});
  await cleanupProduction(prodId).catch(() => {});
});

describe("listGrantLedger", () => {
  it("status 派生：active / expired / revoked 三态", async () => {
    const { rows, total } = await listGrantLedger(prodId, { userId });
    expect(total).toBe(3);
    const byId = new Map(rows.map(r => [r.id, r]));
    expect(byId.get(activeId)?.status).toBe("active");
    expect(byId.get(expiredId)?.status).toBe("expired");
    expect(byId.get(revokedId)?.status).toBe("revoked");
    expect(byId.get(activeId)?.userName).toBe("审计对象");
  });

  it("status 筛选只回对应态", async () => {
    const active = await listGrantLedger(prodId, { userId, status: "active" });
    expect(active.rows.map(r => r.id)).toEqual([activeId]);
    const expired = await listGrantLedger(prodId, { userId, status: "expired" });
    expect(expired.rows.map(r => r.id)).toEqual([expiredId]);
  });
});

describe("revokeGrantById", () => {
  it("撤销有效行→manual；重复撤销与跨项目撤销返回 false", async () => {
    expect(await revokeGrantById(prodId, activeId)).toBe(true);
    const { rows } = await listGrantLedger(prodId, { userId, status: "revoked" });
    const revoked = rows.find(r => r.id === activeId);
    expect(revoked?.revokedReason).toBe("manual");
    expect(await revokeGrantById(prodId, activeId)).toBe(false);
    const { prodId: otherProd } = await makeProduction();
    try {
      expect(await revokeGrantById(otherProd, expiredId)).toBe(false);
    } finally {
      await cleanupProduction(otherProd).catch(() => {});
    }
  });
});
