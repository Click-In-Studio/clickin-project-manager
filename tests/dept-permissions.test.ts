/**
 * Comprehensive tests for Phase 3 dept permission system.
 *
 * Covers:
 *  - Pure functions: computeInheritedPermissions, computePocPermissions,
 *    collectDescendants, collectAncestors
 *  - CRUD: createProductionDept, listProductionDepts, updateProductionDept,
 *    deleteProductionDept (dissolution guard)
 *  - Member management: setDeptMembers (add/remove/POC conflict)
 *  - Permission zone: computeUserDeptFreeApprovalZone
 *  - canAccess() deptFreeApprovalZone integration
 *  - Grant cascade revocation: revokeGrantsForDeptRemoval, revokeGrantsForPocLoss
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getPool } from "@/lib/pg";
import {
  computeInheritedPermissions,
  computePocPermissions,
  collectDescendants,
  collectAncestors,
  createProductionDept,
  listProductionDepts,
  getProductionDept,
  updateProductionDept,
  deleteProductionDept,
  getDeptMembers,
  setDeptMembers,
  addResourceDeptManage,
  getOrCreateApprovalConfig,
  recomputeAndRevokeGrants,
  revokeAllGrantsForMember,
} from "@/lib/dept-db";
import {
  setMemberRoles,
  removeProductionMember,
  createProductionRole,
  setRolePermissions,
  deleteProductionRole,
} from "@/lib/db";
import type { PermissionContext } from "@/lib/permissions";

// 批F 后原子键仅剩 org 域 2 枚；本文件测试 zone/recompute 机制本身（键无关），
// 用已退役键作为载荷（RETIRED 棘轮 grep 仅扫 app/lib/components，tests 不在其列）。
const asPerm = (k: string) => k;
import { makeProduction, cleanupProduction, shortId } from "./factories";

// ── Constants ──────────────────────────────────────────────────────────────────

// Fixed test system user — must match global-setup.ts
const TEST_USER = "00000000-0000-0000-0000-000000000001";

// Two extra users for multi-user tests
const EXTRA_USER_1 = "00000000-0000-0000-0000-000000000010";
const EXTRA_USER_2 = "00000000-0000-0000-0000-000000000011";

// ── Production fixture ─────────────────────────────────────────────────────────

let prodId: string;
let versionId: string;

beforeAll(async () => {
  ({ prodId, versionId } = await makeProduction());

  // Create extra users for multi-user scenarios
  const pool = getPool();
  await pool.query(
    "INSERT INTO app_user (id, created_at) VALUES ($1, NOW()), ($2, NOW()) ON CONFLICT DO NOTHING",
    [EXTRA_USER_1, EXTRA_USER_2],
  );
});

afterAll(async () => {
  // Extra users first (app_user CASCADE deletes atomic/resource grants)
  await getPool()
    .query("DELETE FROM app_user WHERE id = ANY($1)", [[EXTRA_USER_1, EXTRA_USER_2]])
    .catch(() => {});
  await cleanupProduction(prodId).catch(() => {});
});

// ── 1. Pure functions ──────────────────────────────────────────────────────────

describe("computeInheritedPermissions", () => {
  // Shared tree fixture for pure function tests:
  //  root (p: [scene:create, scene:view])
  //  └── child (p: [character:create])
  //      └── grandchild (p: [script:view])

  const tree = [
    { id: "root", parent_id: null, permissions: [asPerm("node:announcement/*@edit"), asPerm("node:milestone/*@create")] },
    { id: "child", parent_id: "root", permissions: [asPerm("node:announcement/*@delete")] },
    { id: "grandchild", parent_id: "child", permissions: [asPerm("node:member/*/meta@view")] },
    { id: "sibling", parent_id: "root", permissions: [asPerm("node:member/*/meta@view")] },
  ];

  it("user in leaf dept inherits its own + all ancestor permissions", () => {
    const result = computeInheritedPermissions(["grandchild"], tree);
    expect(result.has(asPerm("node:member/*/meta@view"))).toBe(true);       // own
    expect(result.has(asPerm("node:announcement/*@delete"))).toBe(true);  // parent
    expect(result.has(asPerm("node:announcement/*@edit"))).toBe(true);      // grandparent
    expect(result.has(asPerm("node:milestone/*@create"))).toBe(true);        // grandparent
  });

  it("user in root dept only gets root permissions", () => {
    const result = computeInheritedPermissions(["root"], tree);
    expect(result.has(asPerm("node:announcement/*@edit"))).toBe(true);
    expect(result.has(asPerm("node:milestone/*@create"))).toBe(true);
    expect(result.has(asPerm("node:announcement/*@delete"))).toBe(false); // child — not inherited upward
  });

  it("user in multiple depts gets union of all ancestor chains", () => {
    // member of both grandchild AND sibling
    const result = computeInheritedPermissions(["grandchild", "sibling"], tree);
    expect(result.has(asPerm("node:member/*/meta@view"))).toBe(true);
    expect(result.has(asPerm("node:announcement/*@delete"))).toBe(true);
    expect(result.has(asPerm("node:announcement/*@edit"))).toBe(true);
    expect(result.has(asPerm("node:member/*/meta@view"))).toBe(true); // from sibling
  });

  it("empty dept list returns empty set", () => {
    const result = computeInheritedPermissions([], tree);
    expect(result.size).toBe(0);
  });

  it("dept not in tree returns empty set (unknown dept)", () => {
    const result = computeInheritedPermissions(["nonexistent"], tree);
    expect(result.size).toBe(0);
  });
});

describe("computePocPermissions", () => {
  const tree = [
    { id: "root", parent_id: null, permissions: [asPerm("node:announcement/*@edit")] },
    { id: "child", parent_id: "root", permissions: [asPerm("node:announcement/*@delete")] },
    { id: "grandchild", parent_id: "child", permissions: [asPerm("node:member/*/meta@view")] },
  ];

  it("POC of root gets permissions from all descendants (union)", () => {
    const result = computePocPermissions("root", [], [], tree);
    expect(result.has(asPerm("node:announcement/*@edit"))).toBe(true);
    expect(result.has(asPerm("node:announcement/*@delete"))).toBe(true);
    expect(result.has(asPerm("node:member/*/meta@view"))).toBe(true);
  });

  it("POC of child gets only child + grandchild permissions", () => {
    const result = computePocPermissions("child", [], [], tree);
    expect(result.has(asPerm("node:announcement/*@delete"))).toBe(true);
    expect(result.has(asPerm("node:member/*/meta@view"))).toBe(true);
    expect(result.has(asPerm("node:announcement/*@edit"))).toBe(false); // root — not in child's subtree
  });

  it("poc_extra_permissions are added to the zone", () => {
    const result = computePocPermissions("child", [asPerm("node:member/*/meta@view")], [], tree);
    expect(result.has(asPerm("node:member/*/meta@view"))).toBe(true);
    expect(result.has(asPerm("node:announcement/*@delete"))).toBe(true);
  });

  it("poc_blocked_permissions are excluded from the zone", () => {
    const result = computePocPermissions("root", [], [asPerm("node:announcement/*@delete")], tree);
    expect(result.has(asPerm("node:announcement/*@edit"))).toBe(true);
    expect(result.has(asPerm("node:announcement/*@delete"))).toBe(false); // blocked
    expect(result.has(asPerm("node:member/*/meta@view"))).toBe(true);
  });

  it("blocked overrides extra (cannot re-add a blocked permission)", () => {
    const result = computePocPermissions("root", [asPerm("node:announcement/*@delete")], [asPerm("node:announcement/*@delete")], tree);
    expect(result.has(asPerm("node:announcement/*@delete"))).toBe(false); // blocked wins
  });

  it("leaf dept POC gets only its own permissions", () => {
    const result = computePocPermissions("grandchild", [], [], tree);
    expect(result.has(asPerm("node:member/*/meta@view"))).toBe(true);
    expect(result.has(asPerm("node:announcement/*@delete"))).toBe(false);
  });
});

describe("collectDescendants", () => {
  const tree = [
    { id: "root", parent_id: null, permissions: [] },
    { id: "child", parent_id: "root", permissions: [] },
    { id: "grandchild", parent_id: "child", permissions: [] },
    { id: "other", parent_id: "root", permissions: [] },
  ];

  it("root includes all depts", () => {
    const ids = collectDescendants("root", tree).map((d) => d.id);
    expect(ids).toContain("root");
    expect(ids).toContain("child");
    expect(ids).toContain("grandchild");
    expect(ids).toContain("other");
  });

  it("leaf returns only itself", () => {
    const ids = collectDescendants("grandchild", tree).map((d) => d.id);
    expect(ids).toEqual(["grandchild"]);
  });

  it("child returns itself + grandchild, not other", () => {
    const ids = collectDescendants("child", tree).map((d) => d.id);
    expect(ids).toContain("child");
    expect(ids).toContain("grandchild");
    expect(ids).not.toContain("other");
    expect(ids).not.toContain("root");
  });
});

describe("collectAncestors", () => {
  const tree = [
    { id: "root", parent_id: null, permissions: [] },
    { id: "child", parent_id: "root", permissions: [] },
    { id: "grandchild", parent_id: "child", permissions: [] },
  ];

  it("root has no ancestors", () => {
    expect(collectAncestors("root", tree)).toEqual([]);
  });

  it("child has root as ancestor", () => {
    expect(collectAncestors("child", tree)).toEqual(["root"]);
  });

  it("grandchild has child then root (order: direct parent first)", () => {
    const ancestors = collectAncestors("grandchild", tree);
    expect(ancestors[0]).toBe("child");
    expect(ancestors[1]).toBe("root");
  });
});

// ── 2. CRUD ────────────────────────────────────────────────────────────────────

describe("createProductionDept / listProductionDepts", () => {
  let deptId: string;

  beforeAll(async () => {
    const dept = await createProductionDept({
      productionId: prodId,
      name: "测试部门A",
      displayOrder: 1,
      permissions: [asPerm("node:milestone/*@create"), asPerm("node:member/*/meta@view")],
      allowedCueTypes: ["lights"],
    });
    deptId = dept.id;
  });

  it("created dept appears in listProductionDepts", async () => {
    const depts = await listProductionDepts(prodId);
    const found = depts.find((d) => d.id === deptId);
    expect(found).toBeDefined();
    expect(found!.name).toBe("测试部门A");
    expect(found!.permissions).toContain(asPerm("node:milestone/*@create"));
    expect(found!.allowedCueTypes).toContain("lights");
  });

  it("getProductionDept returns the dept", async () => {
    const dept = await getProductionDept(deptId, prodId);
    expect(dept).not.toBeNull();
    expect(dept!.displayOrder).toBe(1);
  });

  it("getProductionDept returns null for wrong productionId", async () => {
    const dept = await getProductionDept(deptId, "nonexistent-prod");
    expect(dept).toBeNull();
  });

  it("dept has empty member lists by default", async () => {
    const dept = await getProductionDept(deptId, prodId);
    expect(dept!.memberUserIds).toHaveLength(0);
    expect(dept!.pocUserIds).toHaveLength(0);
  });
});

describe("updateProductionDept", () => {
  let deptId: string;

  beforeAll(async () => {
    const dept = await createProductionDept({
      productionId: prodId,
      name: "待更新部门",
      permissions: [asPerm("node:milestone/*@create")],
    });
    deptId = dept.id;
  });

  it("can update name", async () => {
    await updateProductionDept(deptId, prodId, { name: "更新后名称" });
    const dept = await getProductionDept(deptId, prodId);
    expect(dept!.name).toBe("更新后名称");
  });

  it("can update permissions", async () => {
    await updateProductionDept(deptId, prodId, { permissions: [asPerm("node:member/*/meta@view"), asPerm("node:announcement/*@create")] });
    const dept = await getProductionDept(deptId, prodId);
    expect(dept!.permissions).toContain(asPerm("node:member/*/meta@view"));
    expect(dept!.permissions).not.toContain(asPerm("node:milestone/*@create")); // replaced
  });

  it("calling with empty fields is a no-op", async () => {
    const before = await getProductionDept(deptId, prodId);
    await updateProductionDept(deptId, prodId, {});
    const after = await getProductionDept(deptId, prodId);
    expect(after!.name).toBe(before!.name);
  });
});

describe("deleteProductionDept", () => {
  it("returns not_found for nonexistent dept", async () => {
    const result = await deleteProductionDept("00000000-0000-0000-0000-000000000099", prodId);
    expect(result).toEqual({ ok: false, reason: "not_found" });
  });

  it("successfully deletes an empty dept", async () => {
    const dept = await createProductionDept({ productionId: prodId, name: "临时部门" });
    const result = await deleteProductionDept(dept.id, prodId);
    expect(result).toEqual({ ok: true });
    expect(await getProductionDept(dept.id, prodId)).toBeNull();
  });

  it("dissolution guard: blocks delete when resource_dept_manage exists", async () => {
    const dept = await createProductionDept({ productionId: prodId, name: "被管理的部门" });

    // Add a resource_dept_manage record
    await addResourceDeptManage({
      productionId: prodId,
      deptId: dept.id,
      resourceType: "cue_list",
      resourceId: "list-001",
      establishedBy: TEST_USER,
    });

    const result = await deleteProductionDept(dept.id, prodId);
    expect(result).toEqual({ ok: false, reason: "has_resource_manage" });

    // After removing resource_dept_manage, deletion succeeds
    await getPool().query("DELETE FROM resource_dept_manage WHERE dept_id = $1", [dept.id]);
    const result2 = await deleteProductionDept(dept.id, prodId);
    expect(result2).toEqual({ ok: true });
  });

  it("dissolution guard: does not block delete when resource_dept_manage is for other dept", async () => {
    const dept1 = await createProductionDept({ productionId: prodId, name: "部门X" });
    const dept2 = await createProductionDept({ productionId: prodId, name: "部门Y" });

    // dept1 manages a resource, dept2 doesn't
    await addResourceDeptManage({
      productionId: prodId,
      deptId: dept1.id,
      resourceType: "cue_list",
      resourceId: "*",
      establishedBy: TEST_USER,
    });

    // dept2 should delete fine
    const result = await deleteProductionDept(dept2.id, prodId);
    expect(result).toEqual({ ok: true });

    // Cleanup dept1
    await getPool().query("DELETE FROM resource_dept_manage WHERE dept_id = $1", [dept1.id]);
    await deleteProductionDept(dept1.id, prodId);
  });
});

// ── 3. Member management ───────────────────────────────────────────────────────

describe("setDeptMembers: basic add/remove", () => {
  let deptId: string;

  beforeAll(async () => {
    const dept = await createProductionDept({ productionId: prodId, name: "成员测试部门" });
    deptId = dept.id;
  });

  it("adds members", async () => {
    await setDeptMembers(deptId, prodId, [
      { userId: TEST_USER, isPoc: false },
      { userId: EXTRA_USER_1, isPoc: false },
    ]);
    const members = await getDeptMembers(deptId);
    expect(members.map((m) => m.userId)).toContain(TEST_USER);
    expect(members.map((m) => m.userId)).toContain(EXTRA_USER_1);
  });

  it("sets POC status correctly", async () => {
    await setDeptMembers(deptId, prodId, [
      { userId: TEST_USER, isPoc: true },
      { userId: EXTRA_USER_1, isPoc: false },
    ]);
    const members = await getDeptMembers(deptId);
    const testUserRow = members.find((m) => m.userId === TEST_USER);
    const extra1Row = members.find((m) => m.userId === EXTRA_USER_1);
    expect(testUserRow?.isPoc).toBe(true);
    expect(extra1Row?.isPoc).toBe(false);
  });

  it("removes members not in the new list", async () => {
    await setDeptMembers(deptId, prodId, [{ userId: TEST_USER, isPoc: false }]);
    const members = await getDeptMembers(deptId);
    expect(members.map((m) => m.userId)).not.toContain(EXTRA_USER_1);
    expect(members.map((m) => m.userId)).toContain(TEST_USER);
  });

  it("replacing with empty list removes all members", async () => {
    await setDeptMembers(deptId, prodId, []);
    const members = await getDeptMembers(deptId);
    expect(members).toHaveLength(0);
  });

  it("sets poc_extra_permissions and poc_blocked_permissions", async () => {
    await setDeptMembers(deptId, prodId, [
      {
        userId: TEST_USER,
        isPoc: true,
        pocExtraPermissions: [asPerm("node:member/*/meta@view")],
        pocBlockedPermissions: [asPerm("node:milestone/*@create")],
      },
    ]);
    const members = await getDeptMembers(deptId);
    const row = members.find((m) => m.userId === TEST_USER);
    expect(row?.pocExtraPermissions).toContain(asPerm("node:member/*/meta@view"));
    expect(row?.pocBlockedPermissions).toContain(asPerm("node:milestone/*@create"));
  });
});

describe("setDeptMembers: POC conflict resolution", () => {
  let rootDeptId: string;
  let childDeptId: string;

  beforeAll(async () => {
    // Tree: root → child
    const root = await createProductionDept({ productionId: prodId, name: "POC冲突根部门" });
    rootDeptId = root.id;
    const child = await createProductionDept({
      productionId: prodId,
      name: "POC冲突子部门",
      parentId: rootDeptId,
    });
    childDeptId = child.id;
  });

  it("becoming POC of ancestor demotes POC in descendant", async () => {
    // User is POC in child first
    await setDeptMembers(childDeptId, prodId, [{ userId: TEST_USER, isPoc: true }]);
    // Now become POC of root (ancestor)
    await setDeptMembers(rootDeptId, prodId, [{ userId: TEST_USER, isPoc: true }]);
    // User should be demoted in child (no longer POC there)
    const childMembers = await getDeptMembers(childDeptId);
    const childRow = childMembers.find((m) => m.userId === TEST_USER);
    // Either removed from child or demoted to non-POC
    const isPocInChild = childRow?.isPoc ?? false;
    expect(isPocInChild).toBe(false);
  });

  it("parallel depts allow dual POC (no conflict)", async () => {
    // Cleanup first
    await setDeptMembers(rootDeptId, prodId, []);
    await setDeptMembers(childDeptId, prodId, []);

    // Create a sibling dept
    const sibling = await createProductionDept({
      productionId: prodId,
      name: "POC平级部门",
      parentId: rootDeptId,
    });

    // User is POC in both child and sibling (parallel — no conflict)
    await setDeptMembers(childDeptId, prodId, [{ userId: TEST_USER, isPoc: true }]);
    const { pocConflictsResolved } = await setDeptMembers(sibling.id, prodId, [
      { userId: TEST_USER, isPoc: true },
    ]);

    expect(pocConflictsResolved).toHaveLength(0);

    // Both POC statuses preserved
    const childMembers = await getDeptMembers(childDeptId);
    const siblingMembers = await getDeptMembers(sibling.id);
    expect(childMembers.find((m) => m.userId === TEST_USER)?.isPoc).toBe(true);
    expect(siblingMembers.find((m) => m.userId === TEST_USER)?.isPoc).toBe(true);

    // Cleanup sibling
    await deleteProductionDept(sibling.id, prodId);
  });
});

// ── 4. Permission zone ─────────────────────────────────────────────────────────

describe("production_approval_config", () => {
  it("createProduction creates approval config with default 24h TTL", async () => {
    const config = await getOrCreateApprovalConfig(prodId);
    expect(config.ttlHours).toBe(24);
  });

  it("getOrCreateApprovalConfig is idempotent", async () => {
    const config1 = await getOrCreateApprovalConfig(prodId);
    const config2 = await getOrCreateApprovalConfig(prodId);
    expect(config1.ttlHours).toBe(config2.ttlHours);
  });
});

// ── 7. recomputeAndRevokeGrants (role_change) ─────────────────────────────────

describe("removeProductionMember: revokes all grants regardless of grant_source", () => {
  beforeAll(async () => {
    const pool = getPool();
    // Re-add EXTRA_USER_1 as production member (was not removed by describe 7)
    await pool.query(
      "INSERT INTO production_member (production_id, user_id, roles) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
      [prodId, EXTRA_USER_1, []],
    );

    // Insert production_member_grant rows with three different grant sources (id is UUID DEFAULT)
    await pool.query(
      `INSERT INTO production_member_grant
         (production_id, user_id, resource_type, resource_id, resource_sub, permission_level, grant_source)
       VALUES
         ($1, $2, 'scene', 'scene-rm-1', '*', 'view', 'self_confirmed'),
         ($1, $2, 'scene', 'scene-rm-2', '*', 'view', 'approval'),
         ($1, $2, 'scene', 'scene-rm-3', '*', 'view', 'direct')`,
      [prodId, EXTRA_USER_1],
    );

  });

  it("removes member and revokes all active grants with reason member_removed", async () => {
    await removeProductionMember(prodId, EXTRA_USER_1);

    const pool = getPool();

    const { rows: rgRows } = await pool.query<{ is_revoked: boolean; revoked_reason: string }>(
      `SELECT is_revoked, revoked_reason FROM production_member_grant
       WHERE production_id = $1 AND user_id = $2`,
      [prodId, EXTRA_USER_1],
    );
    expect(rgRows.length).toBeGreaterThan(0);
    for (const row of rgRows) {
      expect(row.is_revoked).toBe(true);
      expect(row.revoked_reason).toBe("member_removed");
    }

    const { rows: memberRows } = await pool.query(
      "SELECT 1 FROM production_member WHERE production_id = $1 AND user_id = $2",
      [prodId, EXTRA_USER_1],
    );
    expect(memberRows).toHaveLength(0);
  });
});

// ── 9. updateProductionDept: permissions narrowing ────────────────────────────

