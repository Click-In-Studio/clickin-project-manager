// @vitest-environment jsdom
//
// #659：公告表单的 onSave 是父层的异步请求，以前没 await，saving 同一 tick 内 true→false，
// 「保存中…」与 disabled 从不生效，请求在途时连点会发出多个 POST 产生重复公告。
// 这里钉的是：请求挂起期间按钮灰掉、再点不发第二个请求；失败（非 2xx / 网络错误）
// 在表单里显示原因并恢复按钮，不成为未处理 rejection。
// 反证：把 handleSave 里的 await 去掉，第一条红；去掉 catch，第二三条红。
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import announcementStyles from "@/components/admin/admin-announcements.module.css";

vi.mock("@/components/wiki/WikiMarkdown", () => ({
  default: ({ content, className }: { content: string; className?: string }) => <div className={className}>{content}</div>,
}));
// 富文本编辑器（tiptap）与本测试无关，换成朴素 textarea
vi.mock("@/components/editor/SmartTextarea", () => ({
  default: ({ value, onChange }: { value: string; onChange: (v: string) => void }) => (
    <textarea value={value} onChange={(e) => onChange(e.target.value)} />
  ),
}));

import AdminAnnouncementsClient from "@/components/admin/AdminAnnouncementsClient";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<unknown>>();

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  fetchMock.mockReset();
  // 兜底：发布成功后进入查看态会再取一次阅读状态，与本测试无关
  fetchMock.mockImplementation(() => Promise.resolve({
    ok: true, status: 200, json: () => Promise.resolve({ read: [], unread: [], total: 0 }),
  }));
  (globalThis as { fetch: unknown }).fetch = fetchMock;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function mountNewForm() {
  await act(async () => {
    root.render(
      <AdminAnnouncementsClient
        productionId="prod_test"
        productionName="测试演出"
        recent30Count={0}
        initialAnnouncements={[]}
        canCreate
        canEdit
        canDelete
      />,
    );
  });
  await act(async () => { buttonByText("＋ 新建公告").click(); });
  // 受控 input：走原生 setter + input 事件，React 才会收到 onChange
  const input = container.querySelector<HTMLInputElement>('input[placeholder="公告标题…"]')!;
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setValue.call(input, "安全须知");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const buttonByText = (label: string) =>
  Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((b) => b.textContent === label)!;
const publishButton = () => buttonByText("发布") ?? buttonByText("保存中…");
const postCalls = () => fetchMock.mock.calls.filter(([, init]) => init?.method === "POST");

const announcements = [
  {
    id: "ann_1", title: "安全须知", content: "请确认安全出口。", isPinned: false,
    createdAt: "2026-10-03T00:00:00.000Z", updatedAt: "2026-10-03T00:00:00.000Z",
  },
  {
    id: "ann_2", title: "联排安排", content: "今晚七点集合。", isPinned: false,
    createdAt: "2026-10-02T00:00:00.000Z", updatedAt: "2026-10-02T00:00:00.000Z",
  },
];

async function mountExistingAnnouncements() {
  await act(async () => {
    root.render(
      <AdminAnnouncementsClient
        productionId="prod_test"
        productionName="测试演出"
        recent30Count={2}
        initialAnnouncements={announcements}
        canCreate
        canEdit
        canDelete
      />,
    );
  });
}

describe("AdminAnnouncementsClient — 发布按钮的保存中态（#659）", () => {
  it("请求在途：按钮灰掉显示「保存中…」，连点不发第二个 POST；返回后进入查看态", async () => {
    let resolve!: (v: unknown) => void;
    fetchMock.mockImplementationOnce(() => new Promise((r) => { resolve = r; }));
    await mountNewForm();

    await act(async () => { publishButton().click(); });
    expect(publishButton().disabled).toBe(true);
    expect(publishButton().textContent).toBe("保存中…");

    await act(async () => { publishButton().click(); });
    expect(postCalls()).toHaveLength(1);

    await act(async () => {
      resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ announcement: {
          id: "ann_1", title: "安全须知", content: "", isPinned: false,
          createdAt: "2026-09-23T00:00:00.000Z", updatedAt: "2026-09-23T00:00:00.000Z",
        } }),
      });
    });
    // 表单已卸载、进入查看态：右侧出现公告标题
    expect(container.querySelector('input[placeholder="公告标题…"]')).toBeNull();
    expect(container.textContent).toContain("安全须知");
  });

  it("服务端拒绝（非 2xx）：表单里显示原因，按钮恢复可点", async () => {
    fetchMock.mockImplementationOnce(() => Promise.resolve({
      ok: false, status: 403, json: () => Promise.resolve({ error: "没有发布公告的权限" }),
    }));
    await mountNewForm();

    await act(async () => { publishButton().click(); });
    expect(container.textContent).toContain("没有发布公告的权限");
    expect(publishButton().disabled).toBe(false);
    expect(publishButton().textContent).toBe("发布");
  });

  it("网络错误（fetch 拒绝）：接进表单显示，不成为未处理 rejection", async () => {
    fetchMock.mockImplementationOnce(() => Promise.reject(new TypeError("Failed to fetch")));
    await mountNewForm();

    await act(async () => { publishButton().click(); });
    expect(container.textContent).toContain("网络错误");
    expect(publishButton().disabled).toBe(false);
  });
});

describe("AdminAnnouncementsClient — 响应式改造后的交互回归", () => {
  it("真实组件接入共享指标与公告响应式结构", async () => {
    await mountExistingAnnouncements();

    expect(container.querySelector('[data-admin-metric-grid="standard"]')).toBeTruthy();
    expect(container.querySelector(`.${announcementStyles.workspace}`)).toBeTruthy();
    expect(container.querySelector(`.${announcementStyles.listPane}`)).toBeTruthy();
    expect(container.querySelector(`.${announcementStyles.detailPane}`)).toBeTruthy();
    expect(container.querySelectorAll(`.${announcementStyles.listDate}`)).toHaveLength(2);
  });

  it("选择公告后保留选中态，并可进入编辑、保存再返回详情", async () => {
    await mountExistingAnnouncements();
    const listButton = Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
      .find(button => button.textContent?.includes("联排安排"))!;

    await act(async () => { listButton.click(); });
    expect(listButton.getAttribute("aria-pressed")).toBe("true");
    expect(container.textContent).toContain("今晚七点集合。");
    expect(container.querySelector(`.${announcementStyles.detailDivider}`)).toBeTruthy();
    expect(container.querySelector(`.${announcementStyles.detailBody}`)).toBeTruthy();
    expect(container.querySelector(`.${announcementStyles.readStatus}`)).toBeTruthy();

    await act(async () => { buttonByText("编辑").click(); });
    const input = container.querySelector<HTMLInputElement>('input[placeholder="公告标题…"]')!;
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      setValue.call(input, "联排安排（更新）");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => { buttonByText("保存修改").click(); });

    const patch = fetchMock.mock.calls.find(([, init]) => init?.method === "PATCH");
    expect(patch?.[0]).toContain("/announcements/ann_2");
    expect(JSON.parse(String(patch?.[1]?.body))).toMatchObject({ title: "联排安排（更新）" });
    expect(container.querySelector('input[placeholder="公告标题…"]')).toBeNull();
    expect(container.textContent).toContain("联排安排（更新）");
  });

  it("置顶操作仍调用原 PATCH，并同步列表与详情选中态", async () => {
    await mountExistingAnnouncements();
    const listButton = Array.from(container.querySelectorAll<HTMLButtonElement>("button"))
      .find(button => button.textContent?.includes("安全须知"))!;

    await act(async () => { listButton.click(); });
    await act(async () => { buttonByText("置顶").click(); });

    const patch = fetchMock.mock.calls.find(([, init]) => init?.method === "PATCH");
    expect(patch?.[0]).toContain("/announcements/ann_1");
    expect(JSON.parse(String(patch?.[1]?.body))).toEqual({ isPinned: true });
    expect(listButton.getAttribute("aria-pressed")).toBe("true");
    expect(buttonByText("取消置顶")).toBeTruthy();
  });
});
