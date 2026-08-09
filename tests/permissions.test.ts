import { describe, expect, it } from "vitest";
import { hasPermission, type Permission, type PermissionContext } from "@/lib/permissions";

function contextWith(...permissions: Permission[]): PermissionContext {
  return {
    userId: "user",
    isAdmin: false,
    isOwner: false,
    memberPermissions: new Set(permissions),
    overrides: new Map(),
    deptIds: [],
    pocDeptIds: [],
    deptFreeApprovalZone: new Set(),
    activeGrants: new Set(permissions),
  };
}

describe("script permission hierarchy", () => {
  it("script:manage grants the aggregate edit and annotate capabilities", () => {
    const context = contextWith("script:manage");

    expect(hasPermission("script:edit", context)).toBe(true);
    expect(hasPermission("script:annotate", context)).toBe(true);
    expect(hasPermission("script:create_block", context)).toBe(true);
    expect(hasPermission("script:reorder", context)).toBe(true);
  });

  it("script:edit grants annotate but not manage", () => {
    const context = contextWith("script:edit");

    expect(hasPermission("script:annotate", context)).toBe(true);
    expect(hasPermission("rehearsal_mark:create", context)).toBe(true);
    expect(hasPermission("script:manage", context)).toBe(false);
  });

  it("script:annotate does not grant edit operations", () => {
    const context = contextWith("script:annotate");

    expect(hasPermission("rehearsal_mark:create", context)).toBe(true);
    expect(hasPermission("script:edit", context)).toBe(false);
    expect(hasPermission("script:create_block", context)).toBe(false);
  });

  it("keeps direct overrides above role hierarchy implications", () => {
    const context = contextWith("script:manage");
    context.overrides.set("script:edit", false);

    expect(hasPermission("script:edit", context)).toBe(false);
    expect(hasPermission("script:create_block", context)).toBe(true);
  });
});
