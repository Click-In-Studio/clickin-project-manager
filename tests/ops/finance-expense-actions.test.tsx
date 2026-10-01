// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
vi.mock("@/components/ui/OverflowSafeSelect", () => ({
  default: ({ children, ...props }: React.SelectHTMLAttributes<HTMLSelectElement>) => (
    <select {...props}>{children}</select>
  ),
}));
const uploadCounter = vi.hoisted(() => ({ value: 0 }));
vi.mock("@/components/assets/AssetUploadPanel", () => ({
  default: ({ onUploaded }: { onUploaded: (result: Record<string, unknown>) => void }) => (
    <button type="button" onClick={() => {
      uploadCounter.value += 1;
      onUploaded({
        assetId: `ast_${uploadCounter.value}`, fileId: `af_${uploadCounter.value}`, fileName: `票据${uploadCounter.value}.pdf`,
        name: null, assetType: "financial_document", storageType: "r2",
      });
    }}>上传测试凭证</button>
  ),
}));
vi.mock("@/components/ops/ExpenseRecognitionSuggestions", () => ({
  ExpenseRecognitionSuggestions: () => null,
  recognitionStatusText: () => "等待识别",
}));

import {
  ExpenseAddDocumentButton, ExpenseApprovalActions, ExpenseCreateButton,
} from "@/components/ops/FinanceExpenseActions";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<unknown>>();
const jsonResponse = (body: unknown, status = 200) => Promise.resolve({
  ok: status < 300,
  status,
  json: () => Promise.resolve(body),
});

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  refresh.mockReset();
  fetchMock.mockReset();
  uploadCounter.value = 0;
  (globalThis as { fetch: unknown }).fetch = fetchMock;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function button(label: string) {
  return [...container.querySelectorAll<HTMLButtonElement>("button")]
    .find(item => item.textContent?.trim() === label)!;
}

function inputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("报销填单", () => {
  it("空白内容也能保存为服务端草稿", async () => {
    fetchMock.mockImplementation(() => jsonResponse({ expense: { id: "exp_draft" } }, 201));
    await act(async () => root.render(<ExpenseCreateButton productionId="prod_1" categories={[]} />));
    await act(async () => button("＋ 新建报销").click());
    const submitEvent = new Event("submit", { bubbles: true, cancelable: true });
    Object.defineProperty(submitEvent, "submitter", { value: button("保存草稿") });
    await act(async () => container.querySelector("form")!.dispatchEvent(submitEvent));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toMatchObject({
      intent: "draft", title: "", amount: "", documents: [],
    });
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("金额始终以字符串原样提交，成功后关闭并刷新服务端列表", async () => {
    fetchMock.mockImplementation(() => jsonResponse({ expense: { id: "exp_1" } }, 201));
    await act(async () => root.render(
      <ExpenseCreateButton
        productionId="prod_1"
        categories={[{ id: "cat_1", name: "交通", deptName: "制作组" }]}
      />,
    ));

    await act(async () => button("＋ 新建报销").click());
    const inputs = [...container.querySelectorAll<HTMLInputElement>("input")];
    await act(async () => {
      inputValue(inputs[0], "合成排练打车");
      inputValue(inputs[1], "999999999999.99");
    });
    await act(async () => {
      container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(String(init?.body))).toMatchObject({
      title: "合成排练打车",
      amount: "999999999999.99",
      categoryId: null,
      invoiceRequirement: "required",
      documents: [],
    });
    expect(typeof JSON.parse(String(init?.body)).amount).toBe("string");
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(container.querySelector("[role=dialog]")).toBeNull();
  });

  it("服务端拒绝时保留表单并显示原因", async () => {
    fetchMock.mockImplementation(() => jsonResponse({ error: "找不到这笔支出的审批人，请联系制作人" }, 409));
    await act(async () => root.render(<ExpenseCreateButton productionId="prod_1" categories={[]} />));
    await act(async () => button("＋ 新建报销").click());
    const inputs = [...container.querySelectorAll<HTMLInputElement>("input")];
    await act(async () => {
      inputValue(inputs[0], "交通费");
      inputValue(inputs[1], "12.30");
      container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });

    expect(container.querySelector("[role=dialog]")).not.toBeNull();
    expect(container.querySelector("[role=alert]")?.textContent).toContain("找不到这笔支出的审批人");
    expect(refresh).not.toHaveBeenCalled();
  });

  it("可以连续添加多份凭证并随报销一次提交", async () => {
    fetchMock.mockImplementation(() => jsonResponse({ expense: { id: "exp_docs" } }, 201));
    await act(async () => root.render(<ExpenseCreateButton productionId="prod_1" categories={[]} />));
    await act(async () => button("＋ 新建报销").click());
    await act(async () => button("上传测试凭证").click());
    await act(async () => button("上传测试凭证").click());

    const inputs = [...container.querySelectorAll<HTMLInputElement>("input")];
    await act(async () => {
      inputValue(inputs[0], "两张发票");
      inputValue(inputs[1], "88.00");
      container.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });

    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body.documents).toEqual([
      { assetFileId: "af_1", kind: "invoice" },
      { assetFileId: "af_2", kind: "invoice" },
    ]);
  });
});

describe("报销审批", () => {
  it("不能终局时显示“向上转交”，成功后刷新待办", async () => {
    fetchMock.mockImplementation(() => jsonResponse({ forwarded: true }));
    await act(async () => root.render(
      <ExpenseApprovalActions productionId="prod_1" expenseId="exp_1" canFinalize={false} mutationSeq={0} />,
    ));

    await act(async () => button("向上转交").click());
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({
      action: "approve", comment: "", expectedMutationSeq: 0,
    });
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("驳回需要二次确认", async () => {
    fetchMock.mockImplementation(() => jsonResponse({ expense: { status: "rejected" } }));
    await act(async () => root.render(
      <ExpenseApprovalActions productionId="prod_1" expenseId="exp_1" canFinalize mutationSeq={0} />,
    ));

    await act(async () => button("驳回").click());
    expect(fetchMock).not.toHaveBeenCalled();
    expect(container.textContent).toContain("确认驳回？");
    const textarea = container.querySelector<HTMLTextAreaElement>("textarea")!;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    await act(async () => {
      setter.call(textarea, "票据抬头不符");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => button("确认驳回").click());
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({
      action: "reject", comment: "票据抬头不符", expectedMutationSeq: 0,
    });
  });
});

describe("报销补票", () => {
  it("上传完成后把具体 asset_file 追加到原报销并刷新", async () => {
    fetchMock.mockImplementation(() => jsonResponse({ expense: { id: "exp_1", invoiceState: "provided" } }, 201));
    await act(async () => root.render(
      <ExpenseAddDocumentButton productionId="prod_1" expenseId="exp_1" mutationSeq={0} />,
    ));

    await act(async () => button("补充凭证").click());
    await act(async () => button("上传测试凭证").click());
    await act(async () => { await Promise.resolve(); });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toContain("/finance/expenses/exp_1/documents");
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({
      assetFileId: "af_1", kind: "invoice", expectedMutationSeq: 0,
    });
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
