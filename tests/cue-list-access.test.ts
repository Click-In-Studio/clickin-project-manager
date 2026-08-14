/**
 * Unit tests for Phase 4 cue list production_member_grant access control.
 *
 * Tests cover:
 *   - createCueList writes manage grant for creator
 *   - createCueList writes resource_dept_manage when template matches dept.allowed_cue_types
 *   - hasListAccess returns true for edit/manage grant holders
 *   - hasListAccess returns false for users with no grant
 *   - getCueListGrantLevel returns correct level
 *   - getCueListAccess: already-granted → { canAccess: true }
 *   - getCueListAccess: free-approval zone (POC) → { canSelfConfirm: true }
 *   - getCueListAccess: no zone → { canSelfConfirm: false }
 *   - selfConfirmCueListGrant writes grant; idempotent on repeat
 *   - setCueListGrant (direct) grants/revokes
 *   - listCueListsWithAccess correctly marks editable lists
 *   - getUserAllowedCueTypes reads from dept.allowed_cue_types
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getPool } from "@/lib/pg";
import {
  createCueList, hasListAccess, listCueListsWithAccess,
  getUserAllowedCueTypes, getCueList,
} from "@/lib/db";
import {
  getCueListGrantLevel, getCueListAccess,
  selfConfirmCueListGrant, checkCueListFreeApprovalZone,
  setCueListGrant, listCueListGrants,
} from "@/lib/resource-grant-db";
import { makeProduction, cleanupProduction } from "./factories";

// ── Test helpers ──────────────────────────────────────────────────────────────

// Fixed UUIDs for test users (different from global TEST_USER = ...0001)
const CREATOR_USER   = "00000000-cafe-0001-0000-000000000001";
const EDITOR_USER    = "00000000-cafe-0001-0000-000000000002";
const OUTSIDER_USER  = "00000000-cafe-0001-0000-000000000003";
const POC_USER       = "00000000-cafe-0001-0000-000000000004";

let prodId: string;
let cueListId: string;
let deptId: string;

async function ensureUser(userId: string, name: string) {
  await getPool().query(
    "INSERT INTO app_user (id, created_at) VALUES ($1, NOW()) ON CONFLICT DO NOTHING",
    [userId],
  );
  await getPool().query(
    `INSERT INTO feishu_user (open_id, user_id, name, is_super_admin, created_at, updated_at)
     VALUES ($1, $2, $3, FALSE, NOW(), NOW()) ON CONFLICT DO NOTHING`,
    [`test-cla-${userId.slice(-4)}`, userId, name],
  );
}

async function addMember(prodId: string, userId: string, roles: string[] = []) {
  await getPool().query(
    "INSERT INTO production_member (production_id, user_id, roles) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
    [prodId, userId, roles],
  );
}

async function createDept(prodId: string, name: string, _permissions: string[] = [], allowedCueTypes: string[] = []) {
  const res = await getPool().query<{ id: string }>(
    `INSERT INTO production_dept (production_id, name, display_order)
     VALUES ($1, $2, 1) RETURNING id`,
    [prodId, name],
  );
  // §3.5：数组语义已迁移到声明表（can_create + 设计全档）——工厂同步写声明行
  for (const t of allowedCueTypes) {
    await getPool().query(
      `INSERT INTO dept_cue_list_template (production_id, dept_id, template, can_create, permissions)
       VALUES ($1, $2, $3, true, ARRAY['@view','@edit','cues@create','cues@delete','grants@edit'])
       ON CONFLICT (dept_id, template) DO NOTHING`,
      [prodId, res.rows[0].id, t],
    );
  }
  return res.rows[0].id;
}

async function addDeptMember(deptId: string, prodId: string, userId: string, isPoc = false) {
  await getPool().query(
    `INSERT INTO production_dept_member (dept_id, production_id, user_id, is_poc)
     VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
    [deptId, prodId, userId, isPoc],
  );
}

const nextListId = (() => {
  let seq = 0;
  return () => `cl_test_phase4_${(++seq).toString().padStart(4, "0")}`;
})();

// ── Setup / Teardown ──────────────────────────────────────────────────────────

beforeAll(async () => {
  const prod = await makeProduction();
  prodId = prod.prodId;

  await Promise.all([
    ensureUser(CREATOR_USER,  "创建者"),
    ensureUser(EDITOR_USER,   "编辑者"),
    ensureUser(OUTSIDER_USER, "局外人"),
    ensureUser(POC_USER,      "部门POC"),
  ]);
  await Promise.all([
    addMember(prodId, CREATOR_USER),
    addMember(prodId, EDITOR_USER),
    addMember(prodId, OUTSIDER_USER),
    addMember(prodId, POC_USER),
  ]);

  // Create dept with 灯光 in allowed_cue_types（批A：伪键退役，zone 资格走
  // production_dept_permission 节点行——迁移后的真实形态）
  deptId = await createDept(prodId, "灯光组", [], ["灯光"]);
  await addDeptMember(deptId, prodId, EDITOR_USER, false);
  await addDeptMember(deptId, prodId, POC_USER, true);

  // Create a cue list for testing (not via createCueList — we want to control grants manually)
  cueListId = nextListId();
  await getPool().query(
    "INSERT INTO cue_list (id, production_id, name, notes, created_by) VALUES ($1, $2, $3, '', $4)",
    [cueListId, prodId, "测试灯光表", CREATOR_USER],
  );
  // Manually give EDITOR_USER an edit grant（批A：行集——授权时发多行，edit 必伴 view）
  await getPool().query(
    `INSERT INTO production_member_grant (production_id, user_id, resource_type, resource_id, resource_sub, permission_level, grant_source)
     VALUES ($1, $2, 'cue_list', $3, '*', 'edit', 'direct'),
            ($1, $2, 'cue_list', $3, '*', 'view', 'direct')
     ON CONFLICT DO NOTHING`,
    [prodId, EDITOR_USER, cueListId],
  );
});

afterAll(async () => {
  await getPool().query(
    "DELETE FROM production_member_grant WHERE production_id = $1",
    [prodId],
  ).catch(() => {});
  await getPool().query(
    "DELETE FROM resource_dept_manage WHERE production_id = $1",
    [prodId],
  ).catch(() => {});
  for (const uid of [CREATOR_USER, EDITOR_USER, OUTSIDER_USER, POC_USER]) {
    await getPool().query(
      "DELETE FROM app_user WHERE id = $1",
      [uid],
    ).catch(() => {});
  }
  await cleanupProduction(prodId).catch(() => {});
});

// ── 1. createCueList writes manage grant ──────────────────────────────────────

describe("createCueList", () => {
  it("writes creator verb row-set (批A：manage 单行 → 六行动词行集)", async () => {
    const listId = nextListId();
    await createCueList({
      id: listId, productionId: prodId, name: "新建表",
      notes: "", abbr: null, template: null, createdBy: CREATOR_USER,
    });
    const { rows } = await getPool().query<{ resource_sub: string; permission_level: string }>(
      `SELECT resource_sub, permission_level FROM production_member_grant
       WHERE production_id = $1 AND user_id = $2
         AND resource_type = 'cue_list' AND resource_id = $3 AND NOT is_revoked`,
      [prodId, CREATOR_USER, listId],
    );
    const got = rows.map((r) => `${r.resource_sub}@${r.permission_level}`).sort();
    expect(got).toEqual(
      ["*@view", "*@edit", "*@delete", "cues@create", "cues@delete", "grants@edit"].sort(),
    );
  });

  it("writes resource_dept_manage when template matches dept.allowed_cue_types", async () => {
    const listId = nextListId();
    // POC_USER is member of deptId (灯光组 with allowed_cue_types=['灯光'])
    await createCueList({
      id: listId, productionId: prodId, name: "灯光POC创建",
      notes: "", abbr: null, template: "灯光", createdBy: POC_USER,
    });
    const { rows } = await getPool().query(
      `SELECT id FROM resource_dept_manage
       WHERE production_id = $1 AND dept_id = $2
         AND resource_type = 'cue_list' AND resource_id = $3`,
      [prodId, deptId, listId],
    );
    expect(rows).toHaveLength(1);
  });

  it("does NOT write resource_dept_manage when template doesn't match", async () => {
    const listId = nextListId();
    // CREATOR_USER has no dept membership, so no resource_dept_manage should be written
    await createCueList({
      id: listId, productionId: prodId, name: "无部门创建",
      notes: "", abbr: null, template: "音效", createdBy: CREATOR_USER,
    });
    const { rows } = await getPool().query(
      `SELECT id FROM resource_dept_manage
       WHERE production_id = $1 AND resource_type = 'cue_list' AND resource_id = $2`,
      [prodId, listId],
    );
    expect(rows).toHaveLength(0);
  });
});

// ── 2. hasListAccess ──────────────────────────────────────────────────────────

describe("hasListAccess", () => {
  it("returns true for user with edit grant", async () => {
    expect(await hasListAccess(cueListId, EDITOR_USER)).toBe(true);
  });

  it("returns false for user with no grant", async () => {
    expect(await hasListAccess(cueListId, OUTSIDER_USER)).toBe(false);
  });
});

// ── 3. getCueListGrantLevel ───────────────────────────────────────────────────

describe("getCueListGrantLevel", () => {
  it("returns 'edit' for EDITOR_USER", async () => {
    expect(await getCueListGrantLevel(EDITOR_USER, prodId, cueListId)).toBe("edit");
  });

  it("returns null for OUTSIDER_USER", async () => {
    expect(await getCueListGrantLevel(OUTSIDER_USER, prodId, cueListId)).toBeNull();
  });
});

// ── 4. checkCueListFreeApprovalZone ──────────────────────────────────────────

describe("checkCueListFreeApprovalZone", () => {
  let managedListId: string;

  beforeAll(async () => {
    managedListId = nextListId();
    await getPool().query(
      "INSERT INTO cue_list (id, production_id, name, notes, created_by) VALUES ($1, $2, $3, '', $4)",
      [managedListId, prodId, "POC管理表", CREATOR_USER],
    );
    // Add resource_dept_manage so dept manages this list
    await getPool().query(
      `INSERT INTO resource_dept_manage (production_id, dept_id, resource_type, resource_id, established_by)
       VALUES ($1, $2, 'cue_list', $3, $4) ON CONFLICT DO NOTHING`,
      [prodId, deptId, managedListId, CREATOR_USER],
    );
    // 批A：dept 管辖的表 → dept_permission 实例行集（zone 键与 grant 键同词汇）
    await getPool().query(
      `INSERT INTO production_dept_permission (production_id, dept_id, permission_key)
       SELECT $1, $2, unnest(ARRAY[
         'node:cue_list/' || $3 || '@view',
         'node:cue_list/' || $3 || '@edit',
         'node:cue_list/' || $3 || '/cues@create',
         'node:cue_list/' || $3 || '/cues@delete'
       ]) ON CONFLICT DO NOTHING`,
      [prodId, deptId, managedListId],
    );
  });

  it("EDITOR_USER (dept member with cue_list:edit) can self-confirm edit", async () => {
    expect(await checkCueListFreeApprovalZone(EDITOR_USER, prodId, managedListId, "edit")).toBe(true);
  });

  it("POC_USER can self-confirm edit (POC of managing dept)", async () => {
    expect(await checkCueListFreeApprovalZone(POC_USER, prodId, managedListId, "edit")).toBe(true);
  });

  it("POC_USER can self-confirm manage (POC of managing dept)", async () => {
    expect(await checkCueListFreeApprovalZone(POC_USER, prodId, managedListId, "manage")).toBe(true);
  });

  it("EDITOR_USER cannot self-confirm manage (not POC)", async () => {
    expect(await checkCueListFreeApprovalZone(EDITOR_USER, prodId, managedListId, "manage")).toBe(false);
  });

  it("OUTSIDER_USER cannot self-confirm edit (no dept membership)", async () => {
    expect(await checkCueListFreeApprovalZone(OUTSIDER_USER, prodId, managedListId, "edit")).toBe(false);
  });

  it("returns false for a cue list not covered by dept permission rows", async () => {
    expect(await checkCueListFreeApprovalZone(EDITOR_USER, prodId, cueListId, "edit")).toBe(false);
  });
});

// ── 5. getCueListAccess ───────────────────────────────────────────────────────

describe("getCueListAccess", () => {
  let managedListId: string;

  beforeAll(async () => {
    managedListId = nextListId();
    await getPool().query(
      "INSERT INTO cue_list (id, production_id, name, notes, created_by) VALUES ($1, $2, $3, '', $4)",
      [managedListId, prodId, "访问检测表", CREATOR_USER],
    );
    await getPool().query(
      `INSERT INTO resource_dept_manage (production_id, dept_id, resource_type, resource_id, established_by)
       VALUES ($1, $2, 'cue_list', $3, $4) ON CONFLICT DO NOTHING`,
      [prodId, deptId, managedListId, CREATOR_USER],
    );
    // 批A：dept 管辖的表 → dept_permission 实例行集（zone 键与 grant 键同词汇）
    await getPool().query(
      `INSERT INTO production_dept_permission (production_id, dept_id, permission_key)
       SELECT $1, $2, unnest(ARRAY[
         'node:cue_list/' || $3 || '@view',
         'node:cue_list/' || $3 || '@edit',
         'node:cue_list/' || $3 || '/cues@create',
         'node:cue_list/' || $3 || '/cues@delete'
       ]) ON CONFLICT DO NOTHING`,
      [prodId, deptId, managedListId],
    );
  });

  it("already-granted user → { canAccess: true, level: 'edit' }", async () => {
    const result = await getCueListAccess(EDITOR_USER, prodId, cueListId);
    expect(result.canAccess).toBe(true);
    if (result.canAccess) expect(result.level).toBe("edit");
  });

  it("POC on managed list → { canAccess: false, canSelfConfirm: true, selfConfirmLevel: 'manage' }", async () => {
    const result = await getCueListAccess(POC_USER, prodId, managedListId);
    expect(result.canAccess).toBe(false);
    if (!result.canAccess) {
      expect(result.canSelfConfirm).toBe(true);
      if (result.canSelfConfirm) expect(result.selfConfirmLevel).toBe("manage");
    }
  });

  it("dept member with cue_list:edit on managed list → selfConfirmLevel 'edit'", async () => {
    // EDITOR_USER has edit grant on cueListId (not managedListId), so test with a fresh user
    const tempUser = "00000000-cafe-0001-0000-000000000099";
    await ensureUser(tempUser, "临时编辑成员");
    await addMember(prodId, tempUser);
    await addDeptMember(deptId, prodId, tempUser, false);

    const result = await getCueListAccess(tempUser, prodId, managedListId);
    expect(result.canAccess).toBe(false);
    if (!result.canAccess) {
      expect(result.canSelfConfirm).toBe(true);
      if (result.canSelfConfirm) expect(result.selfConfirmLevel).toBe("edit");
    }

    await getPool().query("DELETE FROM app_user WHERE id = $1", [tempUser]).catch(() => {});
  });

  it("outsider → { canAccess: false, canSelfConfirm: false }", async () => {
    const result = await getCueListAccess(OUTSIDER_USER, prodId, managedListId);
    expect(result.canAccess).toBe(false);
    if (!result.canAccess) expect(result.canSelfConfirm).toBe(false);
  });
});

// ── 6. selfConfirmCueListGrant ────────────────────────────────────────────────

describe("selfConfirmCueListGrant", () => {
  let selfConfirmListId: string;

  beforeAll(async () => {
    selfConfirmListId = nextListId();
    await getPool().query(
      "INSERT INTO cue_list (id, production_id, name, notes, created_by) VALUES ($1, $2, $3, '', $4)",
      [selfConfirmListId, prodId, "自确认表", CREATOR_USER],
    );
    await getPool().query(
      `INSERT INTO resource_dept_manage (production_id, dept_id, resource_type, resource_id, established_by)
       VALUES ($1, $2, 'cue_list', $3, $4) ON CONFLICT DO NOTHING`,
      [prodId, deptId, selfConfirmListId, CREATOR_USER],
    );
  });

  it("writes self_confirmed grant for user in free-approval zone", async () => {
    await selfConfirmCueListGrant(EDITOR_USER, prodId, selfConfirmListId, "edit");
    const { rows } = await getPool().query(
      `SELECT grant_source FROM production_member_grant
       WHERE production_id = $1 AND user_id = $2
         AND resource_type = 'cue_list' AND resource_id = $3
         AND permission_level = 'edit' AND NOT is_revoked`,
      [prodId, EDITOR_USER, selfConfirmListId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].grant_source).toBe("self_confirmed");
  });

  it("is idempotent on repeat call", async () => {
    await selfConfirmCueListGrant(EDITOR_USER, prodId, selfConfirmListId, "edit");
    const { rows } = await getPool().query(
      `SELECT COUNT(*)::int AS cnt FROM production_member_grant
       WHERE production_id = $1 AND user_id = $2
         AND resource_type = 'cue_list' AND resource_id = $3
         AND permission_level = 'edit' AND NOT is_revoked`,
      [prodId, EDITOR_USER, selfConfirmListId],
    );
    expect(rows[0].cnt).toBe(1);
  });

  it("hasListAccess returns true after self-confirm", async () => {
    expect(await hasListAccess(selfConfirmListId, EDITOR_USER)).toBe(true);
  });
});

// ── 7. setCueListGrant & listCueListGrants ────────────────────────────────────

describe("setCueListGrant and listCueListGrants", () => {
  let grantListId: string;

  beforeAll(async () => {
    grantListId = nextListId();
    await getPool().query(
      "INSERT INTO cue_list (id, production_id, name, notes, created_by) VALUES ($1, $2, $3, '', $4)",
      [grantListId, prodId, "直接授权表", CREATOR_USER],
    );
  });

  it("setCueListGrant(true) grants direct edit access", async () => {
    await setCueListGrant(grantListId, prodId, OUTSIDER_USER, true, CREATOR_USER);
    expect(await hasListAccess(grantListId, OUTSIDER_USER)).toBe(true);
  });

  it("listCueListGrants includes the newly granted user", async () => {
    const grants = await listCueListGrants(grantListId);
    expect(grants.some((g) => g.userId === OUTSIDER_USER && g.level === "edit")).toBe(true);
  });

  it("setCueListGrant(false) revokes access", async () => {
    await setCueListGrant(grantListId, prodId, OUTSIDER_USER, false, CREATOR_USER);
    expect(await hasListAccess(grantListId, OUTSIDER_USER)).toBe(false);
  });

  it("listCueListGrants excludes revoked user", async () => {
    const grants = await listCueListGrants(grantListId);
    expect(grants.some((g) => g.userId === OUTSIDER_USER)).toBe(false);
  });
});

// ── 8. listCueListsWithAccess ─────────────────────────────────────────────────

describe("listCueListsWithAccess", () => {
  it("marks editable lists correctly via production_member_grant", async () => {
    const lists = await listCueListsWithAccess(prodId, EDITOR_USER);
    const target = lists.find((l) => l.id === cueListId);
    expect(target).toBeDefined();
    expect(target?.canEdit).toBe(true);
  });

  it("hides non-granted lists entirely (批A 目录三态：无 view 行不可见)", async () => {
    const lists = await listCueListsWithAccess(prodId, OUTSIDER_USER);
    expect(lists.find((l) => l.id === cueListId)).toBeUndefined();
    // seeAll（admin/owner）仍可见且 canEdit=false
    const all = await listCueListsWithAccess(prodId, OUTSIDER_USER, { seeAll: true });
    const target = all.find((l) => l.id === cueListId);
    expect(target?.canEdit).toBe(false);
  });
});

// ── 9. getUserAllowedCueTypes ─────────────────────────────────────────────────

describe("getUserAllowedCueTypes", () => {
  it("returns cue types from dept.allowed_cue_types for dept member", async () => {
    const types = await getUserAllowedCueTypes(EDITOR_USER, prodId);
    expect(types).toContain("灯光");
  });

  it("returns POC user's dept cue types", async () => {
    const types = await getUserAllowedCueTypes(POC_USER, prodId);
    expect(types).toContain("灯光");
  });

  it("returns empty array for user with no dept membership", async () => {
    const types = await getUserAllowedCueTypes(OUTSIDER_USER, prodId);
    expect(types).toHaveLength(0);
  });
});
