// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/components/ui/PageHeader", () => ({
  default: ({ title }: { title: string }) => <h1>{title}</h1>,
}));

import AdminMilestonesClient from "@/components/admin/AdminMilestonesClient";

const initialMilestone = {
  id: "milestone-existing",
  name: "首演",
  endDate: "2999-10-24",
  sortOrder: 0,
};

function setInput(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

async function click(button: HTMLButtonElement) {
  await act(async () => {
    button.click();
    await Promise.resolve();
  });
}

describe("配置中心里程碑交互回归", () => {
  let container: HTMLDivElement;
  let root: Root;
  const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean };

  beforeAll(() => { actEnvironment.IS_REACT_ACT_ENVIRONMENT = true; });
  afterAll(() => { actEnvironment.IS_REACT_ACT_ENVIRONMENT = false; });

  beforeEach(async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    vi.stubGlobal("fetch", vi.fn());
    vi.stubGlobal("confirm", vi.fn(() => true));

    await act(async () => {
      root.render(
        <AdminMilestonesClient
          productionId="production-responsive"
          productionName="响应式测试项目"
          initialMilestones={[initialMilestone]}
          canCreate
          canManage
          canDelete
        />,
      );
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it("新增后保留表单清空和列表更新", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({
      milestone: { id: "milestone-new", name: "技术合成", endDate: "2999-10-20", sortOrder: 1 },
    }), { status: 201 }));
    const name = container.querySelector<HTMLInputElement>('input[placeholder^="里程碑名称"]')!;
    const date = container.querySelector<HTMLInputElement>('input[type="date"]')!;

    await act(async () => {
      setInput(name, "技术合成");
      setInput(date, "2999-10-20");
    });
    await click([...container.querySelectorAll("button")].find(button => button.textContent === "添加")!);

    expect(fetch).toHaveBeenCalledWith(
      "/api/production/production-responsive/milestones",
      expect.objectContaining({ method: "POST" }),
    );
    expect(container.textContent).toContain("技术合成");
    expect(name.value).toBe("");
    expect(date.value).toBe("");
  });

  it("编辑可取消，也可保存名称和日期", async () => {
    const button = (label: string) => [...container.querySelectorAll("button")].find(item => item.textContent === label)!;
    await click(button("编辑"));
    let editName = [...container.querySelectorAll<HTMLInputElement>('input:not([type="date"])')].find(input => input.value === "首演")!;
    await act(async () => setInput(editName, "取消的名称"));
    await click(button("取消"));
    expect(container.textContent).toContain("首演");
    expect(container.textContent).not.toContain("取消的名称");

    vi.mocked(fetch).mockResolvedValueOnce(new Response(null, { status: 204 }));
    await click(button("编辑"));
    editName = [...container.querySelectorAll<HTMLInputElement>('input:not([type="date"])')].find(input => input.value === "首演")!;
    const editDate = [...container.querySelectorAll<HTMLInputElement>('input[type="date"]')].find(input => input.value === "2999-10-24")!;
    await act(async () => {
      setInput(editName, "新首演");
      setInput(editDate, "2999-10-25");
    });
    await click(button("保存"));

    expect(fetch).toHaveBeenCalledWith(
      "/api/production/production-responsive/milestones/milestone-existing",
      expect.objectContaining({ method: "PATCH" }),
    );
    expect(container.textContent).toContain("新首演");
    expect(container.textContent).toContain("2999 年 10 月 25 日");
  });

  it("确认删除后移除对应里程碑", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(null, { status: 204 }));
    await click([...container.querySelectorAll("button")].find(button => button.textContent === "删除")!);

    expect(confirm).toHaveBeenCalledWith("删除里程碑「首演」？");
    expect(fetch).toHaveBeenCalledWith(
      "/api/production/production-responsive/milestones/milestone-existing",
      { method: "DELETE" },
    );
    expect(container.textContent).not.toContain("首演");
  });
});
