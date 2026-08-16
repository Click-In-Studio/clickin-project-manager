import { describe, it, expect } from "vitest";
import type { PermissionContext } from "@/lib/permissions";
import {
  canWriteReport, canPublishReport, canEditTechReq, canAssignTechReq,
  canViewTechReq, canWriteNote, canEditNote, canModerateNotes, isReportViewer,
} from "@/lib/event-permissions";
import { canViewAsset, filterVisibleAssets, canPublishAsset, canCreateShareToken } from "@/lib/asset-perm";

// owner 代码级旁路回归（PR #246，#228 二次漏网教训）：
// owner 非 member（memberPermissions=null，fails-closed 判空不得先于 owner 短路）、
// 零 grant 行，所有门必须直接放行。函数在 owner 短路后不应触达 DB（零工厂数据）。

function ownerCtx(): PermissionContext {
  return {
    userId: "00000000-0000-0000-0002-000000000001",
    isAdmin: false,
    isOwner: true,
    memberPermissions: null, // owner 可以不是 member
    overrides: new Map(),
    deptIds: [],
    pocDeptIds: [],
    deptFreeApprovalZone: new Set(),
    activeGrants: new Set(),
  };
}

const PROD = "t_nonexistent_prod";

describe("owner bypass — event/report domain (lib/event-permissions.ts)", () => {
  it("all nine gates short-circuit for a non-member owner with zero grants", async () => {
    const ctx = ownerCtx();
    expect(await canWriteReport(ctx, "rp_x", PROD)).toBe(true);
    expect(await canPublishReport(ctx, "rp_x", PROD)).toBe(true);
    expect(await canEditTechReq(ctx, "tq_x", null, PROD)).toBe(true);
    expect(await canAssignTechReq(ctx, "tq_x", PROD)).toBe(true);
    expect(await canViewTechReq(ctx, "tq_x", null, PROD, null, { participantDeptIds: [] })).toBe(true);
    expect(await canWriteNote(ctx, PROD, "ev_x", "dept_x", [])).toBe("moderator");
    expect(await canEditNote(ctx, PROD, "ev_x",
      { authorUserId: "u", departmentId: "d", createdVia: "dept" }, [], "delete")).toBe(true);
    expect(await canModerateNotes(ctx, PROD, "ev_x")).toBe(true);
    expect(await isReportViewer(ctx, PROD)).toBe(true);
  });
});

describe("owner bypass — asset domain (lib/asset-perm.ts)", () => {
  it("view/list/publish/share gates short-circuit for owner", async () => {
    const ctx = ownerCtx();
    const asset = { id: "as_x", isPublic: false };
    expect(await canViewAsset(ctx, PROD, asset, "file")).toBe(true);
    // filterVisibleAssets：owner 不过滤（原 bug——owner 资产列表被滤空）
    const list = [{ id: "a1", isPublic: false }, { id: "a2", isPublic: false }];
    expect(await filterVisibleAssets(ctx, PROD, list)).toEqual(list);
    expect(await canPublishAsset(ctx, PROD, "as_x", "create")).toBe(true);
    expect((await canCreateShareToken(ctx, PROD, asset)).allowed).toBe(true);
  });
});
