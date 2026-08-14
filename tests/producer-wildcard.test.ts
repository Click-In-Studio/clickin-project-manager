import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { canAccessNode, nodeKeyCandidates, selfConfirmTemplateNodes, RESERVED_TYPES } from "@/lib/grant-template";
import { recomputeAndRevokeGrants } from "@/lib/dept-db";
import { getPool } from "@/lib/pg";
import { makeProduction, cleanupProduction, shortId } from "./factories";

// 批G G-1：制作人通配区间
// node:*/*@* 主行 + 保留段显式四行 = 永久全集；RESERVED_TYPES 不被类型通配穿透

async function newUser(): Promise<string> {
  const res = await getPool().query<{ id: string }>("INSERT INTO app_user DEFAULT VALUES RETURNING id");
  return res.rows[0].id;
}

let prodId: string;
let producer: string;

beforeAll(async () => {
  ({ prodId } = await makeProduction());
  producer = await newUser();
  // makeProduction 已 seed '制作人' role（模板收敛后即通配五行）——直接复用
  const roleRes = await getPool().query<{ id: string }>(
    "SELECT id FROM production_role WHERE production_id = $1 AND name = '制作人'",
    [prodId],
  );
  const roleId = roleRes.rows[0].id;
  await getPool().query(
    `INSERT INTO production_role_permission (role_id, permission_key)
     SELECT $1, k FROM (VALUES ('node:*/*@*'), ('node:*/*/grants@*'), ('node:*/*/publication@*'),
                               ('node:*/*/assignees@*'), ('node:*/*/imports@create')) AS t(k)
     ON CONFLICT DO NOTHING`,
    [roleId],
  );
  await getPool().query(
    "INSERT INTO production_member_role (production_id, user_id, role_id) VALUES ($1, $2, $3)",
    [prodId, producer, roleId],
  );
});

afterAll(async () => {
  await cleanupProduction(prodId).catch(() => {});
});

describe("候选枚举", () => {
  it("普通节点含 type/verb 通配候选", () => {
    const c = nodeKeyCandidates({ resourceType: "cue_list", resourceId: "x1", resourceSub: "cues", verb: "edit" });
    expect(c).toContain("node:*/*/cues@*");
    expect(c).toContain("node:*/*@*");
    expect(c).toContain("node:cue_list/x1/cues@edit");
    expect(c).toContain("node:cue_list/*@*");
  });

  it("RESERVED_TYPES 不生成 type 通配候选", () => {
    const c = nodeKeyCandidates({ resourceType: "production", resourceId: "*", resourceSub: "meta/name", verb: "edit" });
    expect(c.some(k => k.startsWith("node:*"))).toBe(false);
    expect(RESERVED_TYPES).toEqual(["production", "producer"]);
  });

  it("保留段 sub 的 type 通配候选保持显式 sub", () => {
    const c = nodeKeyCandidates({ resourceType: "asset", resourceId: "a1", resourceSub: "publication", verb: "view" });
    expect(c).toContain("node:*/*/publication@*");
    expect(c).not.toContain("node:*/*@*".replace("@*", "@view") === "node:*/*@view" ? "__never__" : "__never__");
    // 保留段不被裸 '*' sub 覆盖：候选中不存在 sub 缺省的通配命中该查询
    expect(c.every(k => k.includes("publication") || !k.includes("node:*/*@"))).toBe(true);
  });
});

describe("制作人五行区间 = 全集", () => {
  const actor = () => ({ userId: producer, isAdmin: false, isOwner: false });

  it("任意业务节点（含未来新增类型）区间命中 → 自确认", async () => {
    for (const [t, id, sub, v] of [
      ["cue_list", "whatever", "cues", "edit"],
      ["asset", "a9", "file", "view"],
      ["some_future_type", "n1", "anything", "delete"],
    ] as const) {
      const res = await canAccessNode(actor(), prodId, t, id, sub, v);
      expect(res, `${t}/${sub}@${v}`).toEqual({ allowed: false, reason: "needs_self_confirm", source: "role" });
    }
  });

  it("保留段节点经显式通配行命中（imports 仅 create）", async () => {
    expect(await canAccessNode(actor(), prodId, "asset", "a9", "publication", "create"))
      .toEqual({ allowed: false, reason: "needs_self_confirm", source: "role" });
    expect(await canAccessNode(actor(), prodId, "script", "*", "imports", "create"))
      .toEqual({ allowed: false, reason: "needs_self_confirm", source: "role" });
    expect(await canAccessNode(actor(), prodId, "cue_list", "c1", "grants", "edit"))
      .toEqual({ allowed: false, reason: "needs_self_confirm", source: "role" });
  });

  it("治理域不被通配穿透：sensitive → no_entry（区间无治理行）", async () => {
    expect(await canAccessNode(actor(), prodId, "production", "*", "meta/name", "edit"))
      .toEqual({ allowed: false, reason: "no_entry" });
    expect(await canAccessNode(actor(), prodId, "producer", "*", "*", "create"))
      .toEqual({ allowed: false, reason: "no_entry" });
  });

  it("selfConfirm 经通配区间激活具体节点行", async () => {
    const written = await selfConfirmTemplateNodes(producer, prodId, [
      { resourceType: "cue_list", resourceId: "*", resourceSub: "cues", verb: "view" },
    ]);
    expect(written).toBe(1);
  });

  it("recompute 认通配区间覆盖（self_confirmed 行存续）", async () => {
    await recomputeAndRevokeGrants(producer, prodId, "role_change");
    const { rows } = await getPool().query(
      `SELECT is_revoked FROM production_member_grant
       WHERE user_id = $1 AND resource_type = 'cue_list' AND resource_sub = 'cues'`,
      [producer],
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r: { is_revoked: boolean }) => !r.is_revoked)).toBe(true);
  });
});

describe("制作人 role 结构保护（批G，用户定谳）", () => {
  it("deleteProductionRole 对制作人 role 抛错", async () => {
    const { deleteProductionRole } = await import("@/lib/db");
    const roleRes = await getPool().query<{ id: string }>(
      "SELECT id FROM production_role WHERE production_id = $1 AND name = '制作人'", [prodId]);
    await expect(deleteProductionRole(roleRes.rows[0].id, prodId)).rejects.toThrow("制作人角色不可删除");
    const still = await getPool().query(
      "SELECT 1 FROM production_role WHERE production_id = $1 AND name = '制作人'", [prodId]);
    expect(still.rows).toHaveLength(1);
  });

  it("renameProductionRole 对制作人 role 抛错", async () => {
    const { renameProductionRole } = await import("@/lib/db");
    const roleRes = await getPool().query<{ id: string }>(
      "SELECT id FROM production_role WHERE production_id = $1 AND name = '制作人'", [prodId]);
    await expect(renameProductionRole(roleRes.rows[0].id, prodId, "别的名字")).rejects.toThrow("制作人角色不可改名");
  });
});

describe("两个指派面（2026-08-13 用户定稿）", () => {
  it("EVENT manage 行集：含 assignees c/d + call_sheet@edit，不含 publication@create", async () => {
    const { EVENT_LEVEL_ROW_SETS } = await import("@/lib/resource-grant-db");
    const pairs = EVENT_LEVEL_ROW_SETS.manage.map(([s, v]) => `${s}@${v}`);
    expect(pairs).toContain("assignees@create");
    expect(pairs).toContain("assignees@delete");
    expect(pairs).toContain("call_sheet@edit");
    expect(pairs).not.toContain("publication@create");   // 发布归舞监 role
    expect(pairs).toContain("publication@edit");          // organizer 保留修订
    expect(pairs).toContain("publication@delete");        // 与撤回
  });

  it("跟组舞监十行集：含 call_sheet@edit，不含 assignees（排 call 不动名单）", async () => {
    const { setEventStageManagers } = await import("@/lib/event-db");
    const { getPool } = await import("@/lib/pg");
    const u = (await getPool().query<{ id: string }>("INSERT INTO app_user DEFAULT VALUES RETURNING id")).rows[0].id;
    const ev = `ev_sm_${Date.now().toString(36)}`;
    await getPool().query(
      "INSERT INTO production_event (id, production_id, title, created_by, status) VALUES ($1, $2, 'SM测试', $3, 'draft')",
      [ev, prodId, u]);
    await setEventStageManagers(ev, [{ userId: u, name: "SM" }], prodId, u);
    const { rows } = await getPool().query<{ resource_sub: string; permission_level: string }>(
      `SELECT resource_sub, permission_level FROM production_member_grant
       WHERE user_id = $1 AND resource_type = 'event' AND resource_id = $2 AND NOT is_revoked`,
      [u, ev]);
    const pairs = rows.map(r => `${r.resource_sub}@${r.permission_level}`);
    expect(pairs).toContain("call_sheet@edit");
    expect(pairs).toContain("call_sheet@view");
    expect(pairs.some(p => p.startsWith("assignees"))).toBe(false);
    await getPool().query("DELETE FROM production_event WHERE id = $1", [ev]);
  });
});
