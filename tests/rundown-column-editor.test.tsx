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

  it("uses searchable multi-select dropdowns and keeps them open while selecting", async () => {
    const onClose = vi.fn();

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
      const members = [
        { userId: "user-a", name: "陈雨", roles: ["编剧"], departmentIds: ["dept-a"] },
        { userId: "user-b", name: "林默", roles: ["编曲"], departmentIds: ["dept-b"] },
      ];
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

    await act(async () => root.render(<Harness />));

    const triggers = [...container.querySelectorAll<HTMLButtonElement>('[role="combobox"]')];
    expect(triggers).toHaveLength(3);
    expect(triggers.map(trigger => trigger.getAttribute("aria-label")?.split("，")[0])).toEqual(["部门", "角色", "个人"]);

    await act(async () => triggers[0]?.click());
    const search = container.querySelector<HTMLInputElement>('[aria-label="搜索部门"]');
    expect(search).not.toBeNull();
    await act(async () => {
      if (!search) return;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(search, "多媒体");
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });

    const options = [...container.querySelectorAll<HTMLButtonElement>('[role="option"]')];
    expect(options.map(option => option.textContent?.trim())).toEqual(["多媒体设计"]);
    await act(async () => options.find(option => option.textContent?.includes("多媒体设计"))?.click());

    expect(triggers[0]?.getAttribute("aria-expanded")).toBe("true");
    expect(triggers[0]?.textContent).toContain("创作组、多媒体设计");

    const done = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find(button => button.textContent?.trim() === "完成");
    await act(async () => done?.click());
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
