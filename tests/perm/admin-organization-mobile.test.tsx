// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import AdminOrganizationClient from "@/components/admin/AdminOrganizationClient";

const members = [
  {
    userId: "member-ada",
    name: "艾达",
    avatarUrl: null,
    email: "ada@example.com",
    phone: "13800000000",
    roles: ["舞台监督"],
    tags: ["正式"],
    photoUrl: null,
    supervisorId: null,
    supervisorName: null,
    status: "active" as const,
    statusSource: null,
  },
  {
    userId: "member-bo",
    name: "小博",
    avatarUrl: null,
    email: null,
    phone: null,
    roles: ["演员"],
    tags: [],
    photoUrl: null,
    supervisorId: "member-ada",
    supervisorName: "艾达",
    status: "suspended" as const,
    statusSource: "admin" as const,
  },
];

const depts = [{
  id: "dept-stage",
  name: "舞台组",
  parentId: null,
  kind: "dept" as const,
  displayOrder: 0,
  memberUserIds: ["member-ada", "member-bo"],
  pocUserIds: ["member-ada"],
}];

const ownerCaps = {
  viewContact: true,
  editMember: true,
  invite: true,
  remove: true,
  deptStructure: true,
  deptMembers: true,
  deptPoc: true,
};

const readonlyCaps = {
  viewContact: false,
  editMember: false,
  invite: false,
  remove: false,
  deptStructure: false,
  deptMembers: false,
  deptPoc: false,
};

function props(caps = ownerCaps) {
  return {
    productionId: "prod-mobile-org",
    productionName: "移动端排练项目",
    initialMembers: members,
    initialDepts: depts,
    tags: [{ id: "tag-regular", name: "正式", isSystem: true, productionId: null }],
    roleNames: ["舞台监督", "演员"],
    seatLimit: 20,
    caps,
    currentUserId: "owner-user",
  };
}

function click(element: Element) {
  element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

describe("成员与部门移动工作区", () => {
  let container: HTMLDivElement;
  let root: Root;
  const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean };

  beforeAll(() => { actEnvironment.IS_REACT_ACT_ENVIRONMENT = true; });
  afterAll(() => { actEnvironment.IS_REACT_ACT_ENVIRONMENT = false; });

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("从真实成员列表进入详情，并可返回列表后切换到部门详情", async () => {
    await act(async () => root.render(<AdminOrganizationClient {...props()} />));
    const mobile = container.querySelector<HTMLElement>('[data-testid="organization-mobile-workspace"]')!;

    expect(mobile.querySelector('[data-testid="organization-mobile-member-list"]')?.textContent).toContain("艾达");
    expect(mobile.querySelector('[data-testid="organization-mobile-member-list"]')?.textContent).toContain("舞台监督");
    expect(mobile.textContent).toContain("★ POC");

    await act(async () => click(mobile.querySelector('[aria-label="查看成员：艾达"]')!));
    expect(mobile.querySelector('[data-testid="organization-mobile-detail"]')?.textContent).toContain("ada@example.com");
    expect(mobile.textContent).toContain("部门归属");

    await act(async () => click([...mobile.querySelectorAll("button")].find(button => button.textContent?.includes("返回成员列表"))!));
    await act(async () => click([...container.querySelectorAll("button")].find(button => button.textContent === "部门")!));
    expect(mobile.querySelector('[data-testid="organization-mobile-dept-list"]')?.textContent).toContain("舞台组");

    await act(async () => click(mobile.querySelector('[aria-label="查看部门：舞台组"]')!));
    expect(mobile.querySelector('[data-testid="organization-mobile-detail"]')?.textContent).toContain("成员（2）");
    expect(mobile.textContent).toContain("设为 POC");
    expect(mobile.textContent).toContain("取消 POC");
  });

  it("只读权限仍可浏览真实详情，但不出现邀请、编辑和 POC 写操作", async () => {
    await act(async () => root.render(<AdminOrganizationClient {...props(readonlyCaps)} />));
    const mobile = container.querySelector<HTMLElement>('[data-testid="organization-mobile-workspace"]')!;

    expect(container.textContent).not.toContain("邀请成员");
    await act(async () => click(mobile.querySelector('[aria-label="查看成员：艾达"]')!));
    expect(mobile.textContent).toContain("舞台监督");
    expect(mobile.textContent).not.toContain("ada@example.com");
    expect([...mobile.querySelectorAll("button")].some(button => button.textContent === "编辑")).toBe(false);

    await act(async () => click([...mobile.querySelectorAll("button")].find(button => button.textContent?.includes("返回成员列表"))!));
    await act(async () => click([...container.querySelectorAll("button")].find(button => button.textContent === "部门")!));
    await act(async () => click(mobile.querySelector('[aria-label="查看部门：舞台组"]')!));
    expect(mobile.textContent).toContain("艾达");
    expect(mobile.textContent).not.toContain("设为 POC");
    expect(mobile.textContent).not.toContain("取消 POC");
    expect(mobile.textContent).not.toContain("添加成员");
  });

  it("319、385、767 使用单步移动布局，768 起恢复桌面双栏", () => {
    const css = readFileSync("components/admin/admin-organization.module.css", "utf8");
    const sharedCss = readFileSync("components/ui/my-pages.module.css", "utf8");

    expect(css).toContain("@media (max-width: 767px)");
    expect(css).toMatch(/\.panel\s*\{[\s\S]*?height:\s*auto;[\s\S]*?min-height:\s*0;/);
    expect(css).toContain("@media (max-width: 360px)");
    expect(sharedCss).toMatch(/@media \(min-width: 768px\)[\s\S]*?\.mobileOnly\s*\{\s*display:\s*none;/);
    expect(sharedCss).toMatch(/@media \(max-width: 767px\)[\s\S]*?\.desktopOnly\s*\{\s*display:\s*none;/);
  });
});
