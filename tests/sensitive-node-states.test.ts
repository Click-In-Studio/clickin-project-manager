import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { canAccessNode, selfConfirmTemplateNodes, isSensitiveNode, isRootNode } from "@/lib/grant-template";
import { getPool } from "@/lib/pg";
import { makeProduction, cleanupProduction, shortId } from "./factories";

// 批F：SENSITIVE 三态语义（用户定谳）
// 有区间行 = 审批流入口资格；无区间行 = 连申请入口都没有（no_entry）；
// 区间命中也永不自确认。ROOT = owner-only，连审批通道都没有。

async function newUser(): Promise<string> {
  const res = await getPool().query<{ id: string }>("INSERT INTO app_user DEFAULT VALUES RETURNING id");
  return res.rows[0].id;
}

let prodId: string;
let zoneUser: string;    // role 区间含 sensitive 节点串
let plainUser: string;   // 无区间

beforeAll(async () => {
  ({ prodId } = await makeProduction());
  [zoneUser, plainUser] = await Promise.all([newUser(), newUser()]);
  const roleId = `role_${shortId()}`;
  await getPool().query(
    "INSERT INTO production_role (id, production_id, name) VALUES ($1, $2, '敏感区间角色')",
    [roleId, prodId],
  );
  await getPool().query(
    `INSERT INTO production_role_permission (role_id, permission_key)
     VALUES ($1, 'node:production/*/meta/name@edit'), ($1, 'node:milestone/*@create')`,
    [roleId],
  );
  await getPool().query(
    "INSERT INTO production_member_role (production_id, user_id, role_id) VALUES ($1, $2, $3)",
    [prodId, zoneUser, roleId],
  );
});

afterAll(async () => {
  await cleanupProduction(prodId).catch(() => {});
});

describe("节点分类", () => {
  it("SENSITIVE：production 修改动作、producer 全部；view 面是基线", () => {
    expect(isSensitiveNode("production", "meta/name", "edit")).toBe(true);
    expect(isSensitiveNode("production", "archival", "create")).toBe(true);
    expect(isSensitiveNode("producer", "*", "create")).toBe(true);
    // member 域整个不 sensitive（#262）：在用面 create/delete/roles/overrides/
    // contact/meta 全走完整审批阶梯，人事部门可作共管方接第一级。
    // imports 曾判 sensitive，但全仓无门读它（成员导入走 member@create），已删。
    expect(isSensitiveNode("member", "imports", "create")).toBe(false);
    expect(isSensitiveNode("member", "*", "create")).toBe(false);
    expect(isSensitiveNode("member", "roles", "edit")).toBe(false);
    expect(isSensitiveNode("production", "config", "edit")).toBe(false);
    expect(isSensitiveNode("milestone", "*", "create")).toBe(false);
    // 基线原则（2026-08-13）：权限越基线，修改该权限越敏感——view 不 sensitive
    expect(isSensitiveNode("production", "meta", "view")).toBe(false);
    expect(isSensitiveNode("production", "meta/name", "view")).toBe(false);
    expect(isSensitiveNode("production", "mounts", "view")).toBe(false);
    expect(isSensitiveNode("production", "archival", "view")).toBe(false);
    // 边界：integrations 整面 sensitive（含密钥，查看即敏感）——view 不豁免
    expect(isSensitiveNode("production", "integrations", "view")).toBe(true);
    expect(isSensitiveNode("production", "integrations", "edit")).toBe(true);
  });

  it("ROOT：production delete/owner/restores（owner-only）", () => {
    expect(isRootNode("production", "*", "delete")).toBe(true);
    expect(isRootNode("production", "owner", "edit")).toBe(true);
    expect(isRootNode("production", "restores", "create")).toBe(true);
    expect(isRootNode("production", "meta/name", "edit")).toBe(false);
  });
});

describe("六步链三态", () => {
  const actor = (u: string) => ({ userId: u, isAdmin: false, isOwner: false });

  it("有区间的 sensitive → needs_approval（入口资格，不自确认）", async () => {
    const res = await canAccessNode(actor(zoneUser), prodId, "production", "*", "meta/name", "edit");
    expect(res).toEqual({ allowed: false, reason: "needs_approval" });
  });

  it("无区间的 sensitive → no_entry（连申请入口都没有）", async () => {
    const res = await canAccessNode(actor(plainUser), prodId, "production", "*", "meta/name", "edit");
    expect(res).toEqual({ allowed: false, reason: "no_entry" });
  });

  it("普通节点区间命中照常自确认", async () => {
    const res = await canAccessNode(actor(zoneUser), prodId, "milestone", "*", "*", "create");
    expect(res).toEqual({ allowed: false, reason: "needs_self_confirm", source: "role" });
  });

  it("ROOT 对非 owner 一律 no_entry；owner 走第 1 步旁路", async () => {
    const res = await canAccessNode(actor(zoneUser), prodId, "production", "*", "*", "delete");
    expect(res).toEqual({ allowed: false, reason: "no_entry" });
    const asOwner = await canAccessNode({ userId: zoneUser, isAdmin: false, isOwner: true }, prodId, "production", "*", "*", "delete");
    expect(asOwner).toEqual({ allowed: true });
  });

  it("selfConfirm 对 sensitive 节点零写入", async () => {
    const written = await selfConfirmTemplateNodes(zoneUser, prodId, [
      { resourceType: "production", resourceId: "*", resourceSub: "meta/name", verb: "edit" },
    ]);
    expect(written).toBe(0);
    const rows = await getPool().query(
      `SELECT 1 FROM production_member_grant WHERE user_id = $1 AND resource_type = 'production'`,
      [zoneUser],
    );
    expect(rows.rows).toHaveLength(0);
  });
});
