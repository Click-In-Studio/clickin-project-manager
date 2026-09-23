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

vi.mock("@/components/wiki/WikiMarkdown", () => ({ default: () => null }));
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
