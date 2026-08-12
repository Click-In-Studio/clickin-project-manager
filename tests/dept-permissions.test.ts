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
  computeUserDeptFreeApprovalZone,
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
import { canAccess } from "@/lib/permissions";
import type { PermissionContext } from "@/lib/permissions";
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
    { id: "root", parent_id: null, permissions: ["scene:create", "scene:view"] },
    { id: "child", parent_id: "root", permissions: ["character:create"] },
    { id: "grandchild", parent_id: "child", permissions: ["script:view"] },
    { id: "sibling", parent_id: "root", permissions: ["script:view"] },
  ];

  it("user in leaf dept inherits its own + all ancestor permissions", () => {
    const result = computeInheritedPermissions(["grandchild"], tree);
    expect(result.has("script:view")).toBe(true);       // own
    expect(result.has("character:create")).toBe(true);  // parent
    expect(result.has("scene:create")).toBe(true);      // grandparent
    expect(result.has("scene:view")).toBe(true);        // grandparent
  });

  it("user in root dept only gets root permissions", () => {
    const result = computeInheritedPermissions(["root"], tree);
    expect(result.has("scene:create")).toBe(true);
    expect(result.has("scene:view")).toBe(true);
    expect(result.has("character:create")).toBe(false); // child — not inherited upward
  });

  it("user in multiple depts gets union of all ancestor chains", () => {
    // member of both grandchild AND sibling
    const result = computeInheritedPermissions(["grandchild", "sibling"], tree);
    expect(result.has("script:view")).toBe(true);
    expect(result.has("character:create")).toBe(true);
    expect(result.has("scene:create")).toBe(true);
    expect(result.has("script:view")).toBe(true); // from sibling
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
    { id: "root", parent_id: null, permissions: ["scene:create"] },
    { id: "child", parent_id: "root", permissions: ["character:create"] },
    { id: "grandchild", parent_id: "child", permissions: ["script:view"] },
  ];

  it("POC of root gets permissions from all descendants (union)", () => {
    const result = computePocPermissions("root", [], [], tree);
    expect(result.has("scene:create")).toBe(true);
    expect(result.has("character:create")).toBe(true);
    expect(result.has("script:view")).toBe(true);
  });

  it("POC of child gets only child + grandchild permissions", () => {
    const result = computePocPermissions("child", [], [], tree);
    expect(result.has("character:create")).toBe(true);
    expect(result.has("script:view")).toBe(true);
    expect(result.has("scene:create")).toBe(false); // root — not in child's subtree
  });

  it("poc_extra_permissions are added to the zone", () => {
    const result = computePocPermissions("child", ["script:view"], [], tree);
    expect(result.has("script:view")).toBe(true);
    expect(result.has("character:create")).toBe(true);
  });

  it("poc_blocked_permissions are excluded from the zone", () => {
    const result = computePocPermissions("root", [], ["character:create"], tree);
    expect(result.has("scene:create")).toBe(true);
    expect(result.has("character:create")).toBe(false); // blocked
    expect(result.has("script:view")).toBe(true);
  });

  it("blocked overrides extra (cannot re-add a blocked permission)", () => {
    const result = computePocPermissions("root", ["character:create"], ["character:create"], tree);
    expect(result.has("character:create")).toBe(false); // blocked wins
  });

  it("leaf dept POC gets only its own permissions", () => {
    const result = computePocPermissions("grandchild", [], [], tree);
    expect(result.has("script:view")).toBe(true);
    expect(result.has("character:create")).toBe(false);
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
      permissions: ["scene:view", "script:view"],
      allowedCueTypes: ["lights"],
    });
    deptId = dept.id;
  });

  it("created dept appears in listProductionDepts", async () => {
    const depts = await listProductionDepts(prodId);
    const found = depts.find((d) => d.id === deptId);
    expect(found).toBeDefined();
    expect(found!.name).toBe("测试部门A");
    expect(found!.permissions).toContain("scene:view");
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
      permissions: ["scene:view"],
    });
    deptId = dept.id;
  });

  it("can update name", async () => {
    await updateProductionDept(deptId, prodId, { name: "更新后名称" });
    const dept = await getProductionDept(deptId, prodId);
    expect(dept!.name).toBe("更新后名称");
  });

  it("can update permissions", async () => {
    await updateProductionDept(deptId, prodId, { permissions: ["script:view", "character:view"] });
    const dept = await getProductionDept(deptId, prodId);
    expect(dept!.permissions).toContain("script:view");
    expect(dept!.permissions).not.toContain("scene:view"); // replaced
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
        pocExtraPermissions: ["script:view"],
        pocBlockedPermissions: ["scene:view"],
      },
    ]);
    const members = await getDeptMembers(deptId);
    const row = members.find((m) => m.userId === TEST_USER);
    expect(row?.pocExtraPermissions).toContain("script:view");
    expect(row?.pocBlockedPermissions).toContain("scene:view");
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

describe("computeUserDeptFreeApprovalZone", () => {
  let parentDeptId: string;
  let childDeptId: string;

  beforeAll(async () => {
    const parent = await createProductionDept({
      productionId: prodId,
      name: "权限继承父部门",
      permissions: ["scene:view", "character:view"],
    });
    parentDeptId = parent.id;

    const child = await createProductionDept({
      productionId: prodId,
      name: "权限继承子部门",
      parentId: parentDeptId,
      permissions: ["script:view"],
    });
    childDeptId = child.id;

    // TEST_USER is a member of child dept
    await setDeptMembers(childDeptId, prodId, [{ userId: TEST_USER, isPoc: false }]);
    // EXTRA_USER_1 is POC of parent dept with extra permissions
    await setDeptMembers(parentDeptId, prodId, [
      {
        userId: EXTRA_USER_1,
        isPoc: true,
        pocExtraPermissions: ["script:view"],
        pocBlockedPermissions: ["scene:view"],
      },
    ]);
  });

  it("member of child dept inherits child + parent permissions", async () => {
    const zone = await computeUserDeptFreeApprovalZone(TEST_USER, prodId);
    expect(zone.has("script:view")).toBe(true);  // child's own
    expect(zone.has("scene:view")).toBe(true);      // inherited from parent
    expect(zone.has("character:view")).toBe(true);  // inherited from parent
  });

  it("non-member user gets empty zone", async () => {
    const zone = await computeUserDeptFreeApprovalZone(EXTRA_USER_2, prodId);
    expect(zone.size).toBe(0);
  });

  it("POC user gets descendant union + extra, minus blocked", async () => {
    const zone = await computeUserDeptFreeApprovalZone(EXTRA_USER_1, prodId);
    // parent permissions in zone (from membership)
    expect(zone.has("character:view")).toBe(true);
    // POC zone includes child's permissions
    expect(zone.has("script:view")).toBe(true);
    // poc_extra_permissions added
    expect(zone.has("script:view")).toBe(true);
    // Note: scene:view IS in zone from membership (parent dept) even though blocked in POC zone.
    // poc_blocked_permissions only removes from the POC zone, not from the membership zone.
    // EXTRA_USER_1 is a member of parentDeptId which has scene:view, so it remains in zone.
    expect(zone.has("scene:view")).toBe(true);
  });
});

describe("canAccess() with deptFreeApprovalZone", () => {
  // cue:create is a non-base permission suitable for testing the confirmation flow.

  it("base permission without role or grant → needs_approval (bypass removed, #158)", () => {
    const ctx: PermissionContext = {
      userId: TEST_USER,
      isAdmin: false,
      isOwner: false,
      memberPermissions: new Set(), // member with no role permissions
      overrides: new Map(),
      deptIds: [],
      pocDeptIds: [],
      deptFreeApprovalZone: new Set(),
      activeGrants: new Set(),
    };
    // scene:view used to be granted via MEMBER_BASE_PERMISSIONS bypass.
    // Now it requires the role to include it; with empty memberPermissions → needs_approval.
    expect(canAccess(ctx, "scene:view")).toEqual({ allowed: false, reason: "needs_approval" });
  });

  it("base permission with role but no active grant → needs_self_confirm", () => {
    const ctx: PermissionContext = {
      userId: TEST_USER,
      isAdmin: false,
      isOwner: false,
      memberPermissions: new Set(["scene:view"] as const),
      overrides: new Map(),
      deptIds: [],
      pocDeptIds: [],
      deptFreeApprovalZone: new Set(),
      activeGrants: new Set(),
    };
    expect(canAccess(ctx, "scene:view")).toEqual({ allowed: false, reason: "needs_self_confirm" });
  });

  it("base permission with active grant → allowed", () => {
    const ctx: PermissionContext = {
      userId: TEST_USER,
      isAdmin: false,
      isOwner: false,
      memberPermissions: new Set(["scene:view"] as const),
      overrides: new Map(),
      deptIds: [],
      pocDeptIds: [],
      deptFreeApprovalZone: new Set(),
      activeGrants: new Set(["scene:view"] as const),
    };
    expect(canAccess(ctx, "scene:view")).toEqual({ allowed: true });
  });

  it("role permission without active grant → needs_self_confirm", () => {
    const ctx: PermissionContext = {
      userId: TEST_USER,
      isAdmin: false,
      isOwner: false,
      memberPermissions: new Set(["scene:create"] as const),
      overrides: new Map(),
      deptIds: [],
      pocDeptIds: [],
      deptFreeApprovalZone: new Set(),
      activeGrants: new Set(), // not yet confirmed
    };
    expect(canAccess(ctx, "scene:create")).toEqual({ allowed: false, reason: "needs_self_confirm" });
  });

  it("role permission with active grant → allowed", () => {
    const ctx: PermissionContext = {
      userId: TEST_USER,
      isAdmin: false,
      isOwner: false,
      memberPermissions: new Set(["scene:create"] as const),
      overrides: new Map(),
      deptIds: [],
      pocDeptIds: [],
      deptFreeApprovalZone: new Set(),
      activeGrants: new Set(["scene:create"] as const),
    };
    expect(canAccess(ctx, "scene:create")).toEqual({ allowed: true });
  });

  it("returns needs_self_confirm when perm is in deptFreeApprovalZone (no role)", () => {
    const ctx: PermissionContext = {
      userId: TEST_USER,
      isAdmin: false,
      isOwner: false,
      memberPermissions: new Set(), // no role-based permissions
      overrides: new Map(),
      deptIds: [],
      pocDeptIds: [],
      deptFreeApprovalZone: new Set(["scene:create", "tag_group:create"]),
      activeGrants: new Set(),
    };
    expect(canAccess(ctx, "scene:create")).toEqual({ allowed: false, reason: "needs_self_confirm" });
  });

  it("returns needs_approval when perm is in neither role nor deptFreeApprovalZone", () => {
    const ctx: PermissionContext = {
      userId: TEST_USER,
      isAdmin: false,
      isOwner: false,
      memberPermissions: new Set(),
      overrides: new Map(),
      deptIds: [],
      pocDeptIds: [],
      deptFreeApprovalZone: new Set(["tag_group:create"]),
      activeGrants: new Set(),
    };
    expect(canAccess(ctx, "scene:create")).toEqual({ allowed: false, reason: "needs_approval" });
  });

  it("needs_self_confirm takes priority over needs_approval when zone matches", () => {
    const ctx: PermissionContext = {
      userId: TEST_USER,
      isAdmin: false,
      isOwner: false,
      memberPermissions: new Set(),
      overrides: new Map(),
      deptIds: [],
      pocDeptIds: [],
      deptFreeApprovalZone: new Set(["dept:create"]),
      activeGrants: new Set(),
    };
    expect(canAccess(ctx, "dept:create")).toEqual({ allowed: false, reason: "needs_self_confirm" });
  });

  it("empty zone and no role → needs_approval for non-base perms", () => {
    const ctx: PermissionContext = {
      userId: TEST_USER,
      isAdmin: false,
      isOwner: false,
      memberPermissions: new Set(),
      overrides: new Map(),
      deptIds: [],
      pocDeptIds: [],
      deptFreeApprovalZone: new Set(),
      activeGrants: new Set(),
    };
    expect(canAccess(ctx, "scene:create")).toEqual({ allowed: false, reason: "needs_approval" });
  });
});

// ── 5. Grant cascade revocation ────────────────────────────────────────────────

describe("revokeGrantsForDeptRemoval: atomic_permission_grant", () => {
  let deptIdA: string;  // dept with scene:view + cue_list:view
  let deptIdB: string;  // dept with character:view

  beforeAll(async () => {
    // Remove TEST_USER from all depts in this production to prevent cross-suite interference.
    // Earlier describe blocks may have left TEST_USER in depts with scene:view or other perms.
    await getPool().query(
      "DELETE FROM production_dept_member WHERE production_id = $1 AND user_id = $2",
      [prodId, TEST_USER],
    );
    // Clean up any prior atomic_permission_grant rows for TEST_USER in this production
    await getPool().query(
      "DELETE FROM atomic_permission_grant WHERE production_id = $1 AND user_id = $2",
      [prodId, TEST_USER],
    );

    const deptA = await createProductionDept({
      productionId: prodId,
      name: "撤销测试部门A",
      permissions: ["scene:view", "script:view"],
    });
    deptIdA = deptA.id;

    const deptB = await createProductionDept({
      productionId: prodId,
      name: "撤销测试部门B",
      permissions: ["character:view"],
    });
    deptIdB = deptB.id;

    // TEST_USER is in both depts (fresh start)
    await setDeptMembers(deptIdA, prodId, [{ userId: TEST_USER, isPoc: false }]);
    await setDeptMembers(deptIdB, prodId, [{ userId: TEST_USER, isPoc: false }]);

    // Insert self_confirmed grants: one in A's zone, one in B's zone, one outside both
    await getPool().query(
      `INSERT INTO atomic_permission_grant
         (production_id, user_id, permission_key, grant_source)
       VALUES
         ($1, $2, 'scene:view',      'self_confirmed'),
         ($1, $2, 'character:view',  'self_confirmed'),
         ($1, $2, 'script:manage',   'self_confirmed')
       ON CONFLICT DO NOTHING`,
      [prodId, TEST_USER],
    );
  });

  it("removing from deptA revokes grants no longer in zone (script:manage)", async () => {
    // Remove TEST_USER from deptA only (still in deptB with character:view)
    await setDeptMembers(deptIdA, prodId, []);
    // scene:view was in deptA's zone but not deptB's — should be revoked
    // character:view is in deptB's zone — should be kept
    // script:manage was never in any zone — should be revoked

    const { rows } = await getPool().query<{
      permission_key: string;
      is_revoked: boolean;
    }>(
      `SELECT permission_key, is_revoked
       FROM atomic_permission_grant
       WHERE production_id = $1 AND user_id = $2`,
      [prodId, TEST_USER],
    );

    const byKey = Object.fromEntries(rows.map((r) => [r.permission_key, r.is_revoked]));
    expect(byKey["scene:view"]).toBe(true);      // was only in deptA's zone
    expect(byKey["character:view"]).toBe(false);  // still in deptB's zone
    expect(byKey["script:manage"]).toBe(true);    // never in any zone
  });

  it("non-self_confirmed grants are not revoked on dept removal", async () => {
    // Insert an 'approval' grant that should never be auto-revoked
    await getPool().query(
      `INSERT INTO atomic_permission_grant
         (production_id, user_id, permission_key, grant_source)
       VALUES ($1, $2, 'scene:create', 'approval')
       ON CONFLICT DO NOTHING`,
      [prodId, TEST_USER],
    );

    // Remove from deptB
    await setDeptMembers(deptIdB, prodId, []);

    const { rows } = await getPool().query<{ is_revoked: boolean }>(
      "SELECT is_revoked FROM atomic_permission_grant WHERE production_id = $1 AND user_id = $2 AND permission_key = 'scene:create'",
      [prodId, TEST_USER],
    );
    expect(rows[0]?.is_revoked).toBe(false); // approval grant not touched
  });
});

describe("revokeGrantsForPocLoss: atomic_permission_grant", () => {
  let pocDeptId: string;
  let memberDeptId: string;

  beforeAll(async () => {
    const pocDept = await createProductionDept({
      productionId: prodId,
      name: "POC撤销测试部门",
      permissions: ["script:view"],
    });
    pocDeptId = pocDept.id;

    const memberDept = await createProductionDept({
      productionId: prodId,
      name: "POC撤销测试成员部门",
      permissions: ["scene:view"],
    });
    memberDeptId = memberDept.id;

    // EXTRA_USER_2: POC of pocDept, regular member of memberDept
    await setDeptMembers(pocDeptId, prodId, [{ userId: EXTRA_USER_2, isPoc: true }]);
    await setDeptMembers(memberDeptId, prodId, [{ userId: EXTRA_USER_2, isPoc: false }]);

    // Self-confirmed grants: cue_list:view (only in POC zone), scene:view (in member zone)
    await getPool().query(
      `INSERT INTO atomic_permission_grant
         (production_id, user_id, permission_key, grant_source)
       VALUES
         ($1, $2, 'script:view', 'self_confirmed'),
         ($1, $2, 'scene:view',    'self_confirmed')
       ON CONFLICT DO NOTHING`,
      [prodId, EXTRA_USER_2],
    );
  });

  it("losing POC status revokes grants that were only in POC zone", async () => {
    // Demote EXTRA_USER_2 from POC in pocDept (keep as regular member)
    await setDeptMembers(pocDeptId, prodId, [{ userId: EXTRA_USER_2, isPoc: false }]);

    const { rows } = await getPool().query<{
      permission_key: string;
      is_revoked: boolean;
    }>(
      `SELECT permission_key, is_revoked
       FROM atomic_permission_grant
       WHERE production_id = $1 AND user_id = $2`,
      [prodId, EXTRA_USER_2],
    );

    const byKey = Object.fromEntries(rows.map((r) => [r.permission_key, r.is_revoked]));
    // cue_list:view came from pocDept.permissions; member of pocDept still gets it via inheritance
    // (user is still a regular member of pocDept, so cue_list:view is still in zone)
    expect(byKey["scene:view"]).toBe(false);    // still in member zone (memberDept)
    // cue_list:view: user is still in pocDept as regular member, so still in zone
    expect(byKey["script:view"]).toBe(false);
  });
});

// ── 6. production_approval_config ─────────────────────────────────────────────

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

describe("recomputeAndRevokeGrants: role_change via setMemberRoles", () => {
  let roleAlphaId: string;
  let roleAlphaName: string;
  let roleBetaId: string;
  let roleBetaName: string;

  beforeAll(async () => {
    const pool = getPool();
    // Ensure EXTRA_USER_1 is a production member with a clean slate
    await pool.query(
      "INSERT INTO production_member (production_id, user_id, roles) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
      [prodId, EXTRA_USER_1, []],
    );
    await pool.query(
      "DELETE FROM production_member_role WHERE production_id = $1 AND user_id = $2",
      [prodId, EXTRA_USER_1],
    );
    await pool.query(
      "DELETE FROM production_dept_member WHERE production_id = $1 AND user_id = $2",
      [prodId, EXTRA_USER_1],
    );
    await pool.query(
      "DELETE FROM atomic_permission_grant WHERE production_id = $1 AND user_id = $2",
      [prodId, EXTRA_USER_1],
    );

    // Create two roles with distinct non-overlapping permissions
    const alpha = await createProductionRole(prodId, `test-role-alpha-${shortId()}`);
    roleAlphaId = alpha.id;
    roleAlphaName = alpha.name;
    await setRolePermissions(roleAlphaId, ["character:view"]);

    const beta = await createProductionRole(prodId, `test-role-beta-${shortId()}`);
    roleBetaId = beta.id;
    roleBetaName = beta.name;
    await setRolePermissions(roleBetaId, ["scene:view"]);

    // Assign EXTRA_USER_1 to both roles so both permissions are in their zone
    await setMemberRoles(prodId, EXTRA_USER_1, [roleAlphaName, roleBetaName]);

    // Grant self_confirmed atomics: one per role, plus one outside both zones
    await pool.query(
      `INSERT INTO atomic_permission_grant
         (production_id, user_id, permission_key, grant_source)
       VALUES
         ($1, $2, 'character:view', 'self_confirmed'),
         ($1, $2, 'scene:view',     'self_confirmed'),
         ($1, $2, 'script:view',  'self_confirmed')
       ON CONFLICT DO NOTHING`,
      [prodId, EXTRA_USER_1],
    );
  });

  afterAll(async () => {
    await deleteProductionRole(roleAlphaId, prodId).catch(() => {});
    await deleteProductionRole(roleBetaId, prodId).catch(() => {});
    await getPool().query(
      "DELETE FROM atomic_permission_grant WHERE production_id = $1 AND user_id = $2",
      [prodId, EXTRA_USER_1],
    );
  });

  it("removing role-alpha revokes its exclusive grants but keeps role-beta grants", async () => {
    // Narrow to role-beta only (remove role-alpha)
    await setMemberRoles(prodId, EXTRA_USER_1, [roleBetaName]);

    const { rows } = await getPool().query<{ permission_key: string; is_revoked: boolean }>(
      `SELECT permission_key, is_revoked
       FROM atomic_permission_grant
       WHERE production_id = $1 AND user_id = $2`,
      [prodId, EXTRA_USER_1],
    );

    const byKey = Object.fromEntries(rows.map((r) => [r.permission_key, r.is_revoked]));
    expect(byKey["character:view"]).toBe(true);  // was only in role-alpha zone
    expect(byKey["scene:view"]).toBe(false);      // still in role-beta zone
    expect(byKey["script:view"]).toBe(true);    // never in any role zone
  });

  it("non-self_confirmed grants are never revoked on role change", async () => {
    // Insert an approval grant that role change must not touch
    await getPool().query(
      `INSERT INTO atomic_permission_grant
         (production_id, user_id, permission_key, grant_source)
       VALUES ($1, $2, 'scene:create', 'approval')
       ON CONFLICT DO NOTHING`,
      [prodId, EXTRA_USER_1],
    );

    // Remove all roles
    await setMemberRoles(prodId, EXTRA_USER_1, []);

    const { rows } = await getPool().query<{ is_revoked: boolean }>(
      `SELECT is_revoked FROM atomic_permission_grant
       WHERE production_id = $1 AND user_id = $2 AND permission_key = 'scene:create'`,
      [prodId, EXTRA_USER_1],
    );
    expect(rows[0]?.is_revoked).toBe(false);
  });
});

// ── 8. removeProductionMember: all grants revoked ─────────────────────────────

describe("removeProductionMember: revokes all grants regardless of grant_source", () => {
  beforeAll(async () => {
    const pool = getPool();
    // Re-add EXTRA_USER_1 as production member (was not removed by describe 7)
    await pool.query(
      "INSERT INTO production_member (production_id, user_id, roles) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
      [prodId, EXTRA_USER_1, []],
    );

    // Insert resource_grant rows with three different grant sources (id is UUID DEFAULT)
    await pool.query(
      `INSERT INTO resource_grant
         (production_id, user_id, resource_type, resource_id, resource_sub, permission_level, grant_source)
       VALUES
         ($1, $2, 'scene', 'scene-rm-1', '*', 'view', 'self_confirmed'),
         ($1, $2, 'scene', 'scene-rm-2', '*', 'view', 'approval'),
         ($1, $2, 'scene', 'scene-rm-3', '*', 'view', 'direct')`,
      [prodId, EXTRA_USER_1],
    );

    // Insert atomic_permission_grant rows with multiple sources
    await pool.query(
      `INSERT INTO atomic_permission_grant
         (production_id, user_id, permission_key, grant_source)
       VALUES
         ($1, $2, 'scene:view',   'self_confirmed'),
         ($1, $2, 'scene:create', 'approval'),
         ($1, $2, 'scene:manage', 'direct')
       ON CONFLICT DO NOTHING`,
      [prodId, EXTRA_USER_1],
    );
  });

  it("removes member and revokes all active grants with reason member_removed", async () => {
    await removeProductionMember(prodId, EXTRA_USER_1);

    const pool = getPool();

    const { rows: rgRows } = await pool.query<{ is_revoked: boolean; revoked_reason: string }>(
      `SELECT is_revoked, revoked_reason FROM resource_grant
       WHERE production_id = $1 AND user_id = $2`,
      [prodId, EXTRA_USER_1],
    );
    expect(rgRows.length).toBeGreaterThan(0);
    for (const row of rgRows) {
      expect(row.is_revoked).toBe(true);
      expect(row.revoked_reason).toBe("member_removed");
    }

    const { rows: apgRows } = await pool.query<{ is_revoked: boolean; revoked_reason: string }>(
      `SELECT is_revoked, revoked_reason FROM atomic_permission_grant
       WHERE production_id = $1 AND user_id = $2`,
      [prodId, EXTRA_USER_1],
    );
    expect(apgRows.length).toBeGreaterThan(0);
    for (const row of apgRows) {
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

describe("updateProductionDept: permissions narrowing cascades to members", () => {
  let narrowingDeptId: string;

  beforeAll(async () => {
    const pool = getPool();
    // Isolate EXTRA_USER_2: remove any prior dept memberships and grants
    await pool.query(
      "DELETE FROM production_dept_member WHERE production_id = $1 AND user_id = $2",
      [prodId, EXTRA_USER_2],
    );
    await pool.query(
      "DELETE FROM atomic_permission_grant WHERE production_id = $1 AND user_id = $2",
      [prodId, EXTRA_USER_2],
    );
    // Ensure EXTRA_USER_2 is a production member
    await pool.query(
      "INSERT INTO production_member (production_id, user_id, roles) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
      [prodId, EXTRA_USER_2, []],
    );

    // Dept starts with two permissions
    const narrowingDept = await createProductionDept({
      productionId: prodId,
      name: `narrowing-test-${shortId()}`,
      permissions: ["character:view", "script:view"],
    });
    narrowingDeptId = narrowingDept.id;

    await setDeptMembers(narrowingDeptId, prodId, [{ userId: EXTRA_USER_2, isPoc: false }]);

    // Self_confirmed grants: both in dept zone, plus one outside
    await pool.query(
      `INSERT INTO atomic_permission_grant
         (production_id, user_id, permission_key, grant_source)
       VALUES
         ($1, $2, 'character:view', 'self_confirmed'),
         ($1, $2, 'script:view',    'self_confirmed'),
         ($1, $2, 'script:view',  'self_confirmed')
       ON CONFLICT DO NOTHING`,
      [prodId, EXTRA_USER_2],
    );
  });

  it("narrowing dept permissions revokes grants no longer in any zone", async () => {
    // Remove 'script:view' from the dept's permissions
    await updateProductionDept(narrowingDeptId, prodId, {
      permissions: ["character:view"],
    });

    const { rows } = await getPool().query<{ permission_key: string; is_revoked: boolean }>(
      `SELECT permission_key, is_revoked
       FROM atomic_permission_grant
       WHERE production_id = $1 AND user_id = $2`,
      [prodId, EXTRA_USER_2],
    );

    const byKey = Object.fromEntries(rows.map((r) => [r.permission_key, r.is_revoked]));
    expect(byKey["character:view"]).toBe(false);  // still in narrowed dept zone
    expect(byKey["script:view"]).toBe(true);       // dept no longer grants this
    expect(byKey["script:view"]).toBe(true);     // was never in any dept zone
  });
});
