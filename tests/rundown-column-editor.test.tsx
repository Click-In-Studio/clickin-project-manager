// @vitest-environment jsdom

import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RundownColumnEditor } from "@/components/PlanningClient";

describe("RundownColumnEditor", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  const onClose = vi.fn();

  const members = [
    { userId: "user-a", name: "陈雨", roles: ["编剧"], departmentIds: ["dept-a"] },
    { userId: "user-b", name: "林默", roles: ["编曲"], departmentIds: ["dept-b"] },
  ];

  function Harness() {
    const [column, setColumn] = useState<Parameters<typeof RundownColumnEditor>[0]["column"]>({
      id: "column-a",
      groupId: "group-a",
      name: "任务组",
      kind: "people" as const,
      departmentIds: ["dept-a"],
      userIds: ["user-a"],
      location: "",
      visible: true,
      pinned: false,
    });
    return (
      <RundownColumnEditor
        column={column}
        departments={[
          { id: "dept-a", name: "创作组" },
          { id: "dept-b", name: "多媒体设计" },
          { id: "dept-c", name: "舞台监督组" },
        ]}
        members={members}
        roles={["编剧", "编曲"]}
        onChange={patch => setColumn(current => ({ ...current, ...patch }))}
        onRename={name => setColumn(current => ({ ...current, name }))}
        onToggleValue={(key, value) => setColumn(current => ({
          ...current,
          [key]: current[key].includes(value)
            ? current[key].filter(item => item !== value)
            : [...current[key], value],
        }))}
        onToggleRole={role => {
          const roleUserIds = members.filter(member => member.roles.includes(role)).map(member => member.userId);
          setColumn(current => ({
            ...current,
            userIds: roleUserIds.every(id => current.userIds.includes(id))
              ? current.userIds.filter(id => !roleUserIds.includes(id))
              : [...new Set([...current.userIds, ...roleUserIds])],
          }));
        }}
        onDelete={vi.fn()}
        onClose={onClose}
      />
    );
  }

  /** DropdownPicker 的弹层 portal 到 body（正是为了不被抽屉的 overflow 裁掉），所以不在 container 里找 */
  function popup(): HTMLElement | null {
    return [...document.body.children].find((el): el is HTMLElement => el !== container) ?? null;
  }

  function rows(): HTMLButtonElement[] {
    return [...(popup()?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
  }

  async function type(text: string) {
    const search = popup()?.querySelector("input");
    expect(search).not.toBeNull();
    await act(async () => {
      if (!search) return;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(search, text);
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  beforeEach(() => onClose.mockClear());

  it("uses portal-backed multi pickers and keeps them open while selecting", async () => {
    await act(async () => root.render(<Harness />));

    const triggers = [...container.querySelectorAll<HTMLButtonElement>("button[aria-expanded]")];
    expect(triggers).toHaveLength(3);
    expect(triggers.map(trigger => trigger.textContent?.replace(/[▼▲]/g, "")))
      .toEqual(["已选 1 个部门", "已选 1 个角色", "已选 1 人"]);

    await act(async () => triggers[0]?.click());
    expect(popup()?.querySelector("input")?.getAttribute("placeholder")).toBe("搜索部门…");

    await type("多媒体");
    expect(rows().map(row => row.textContent)).toEqual(["多媒体设计"]);

    await act(async () => rows()[0]?.click());
    // 多选：选完不收起，可以接着勾下一项
    expect(triggers[0]?.getAttribute("aria-expanded")).toBe("true");
    expect(popup()).not.toBeNull();
    expect(triggers[0]?.textContent).toContain("已选 2 个部门");

    const done = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find(button => button.textContent?.trim() === "完成");
    await act(async () => done?.click());
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("groups the member picker by department and searches by role", async () => {
    await act(async () => root.render(<Harness />));

    const memberTrigger = [...container.querySelectorAll<HTMLButtonElement>("button[aria-expanded]")][2];
    await act(async () => memberTrigger?.click());

    // 部门 header 行是 <p>，不可勾选；无成员的「舞台监督组」不出现
    expect([...(popup()?.querySelectorAll("p") ?? [])].map(node => node.textContent))
      .toEqual(["创作组", "多媒体设计"]);

    // 角色走 sublabel，搜索命中后保留其部门 header
    await type("编曲");
    expect([...(popup()?.querySelectorAll("p") ?? [])].map(node => node.textContent)).toEqual(["多媒体设计"]);
    expect(rows().map(row => row.textContent)).toEqual(["林默编曲"]);
  });
});
