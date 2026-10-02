// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ProductionModuleTopMenu from "@/components/shell/ProductionModuleTopMenu";
import {
  PRODUCTION_TOP_MENU_OVERFLOW_SLOT_ID,
  PRODUCTION_TOP_MENU_SLOT_ID,
  PRODUCTION_TOOLBAR_STAGE,
  ProductionToolbarContext,
} from "@/components/shell/ProductionTopMenu";

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
  ExpenseRecognitionSuggestions: ({ documents, onRecognition }: {
    documents: Array<{ assetFileId: string }>;
    onRecognition: (assetFileId: string, recognition: unknown) => void;
  }) => documents[0] ? (
    <button type="button" onClick={() => onRecognition(documents[0].assetFileId, {
      status: "succeeded",
      sourceKind: "pdf_text",
      parserVersion: "p1",
      modelVersion: "m1",
      outdated: false,
      lastError: null,
      attempts: 1,
      updatedAt: "2026-10-01T00:00:00.000Z",
      result: {
        documentType: { value: "receipt", confidence: "high", evidence: "收据" },
        merchant: { value: "某某商店", confidence: "high", evidence: "销售方" },
        occurredOn: { value: "2026-09-30", confidence: "high", evidence: "日期" },
        documentNumber: { value: null, confidence: "low", evidence: null },
        totalAmount: { value: "88.50", confidence: "high", evidence: "合计" },
        taxAmount: { value: null, confidence: "low", evidence: null },
        currency: { value: "CNY", confidence: "high", evidence: "人民币" },
        warnings: [],
      },
    })}>完成识别</button>
  ) : null,
  recognitionStatusText: () => "等待识别",
}));

import {
  ExpenseAddDocumentButton, ExpenseApprovalActions, ExpenseCreateButton, ExpenseSettlementAction,
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
  return [...document.querySelectorAll<HTMLButtonElement>("button")]
    .find(item => item.textContent?.trim() === label)!;
}

function inputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("报销填单", () => {
  it("从最窄顶部栏的更多菜单打开后，菜单关闭但报销表单仍可见可操作", async () => {
    const toolbarSlot = document.createElement("div");
    toolbarSlot.id = PRODUCTION_TOP_MENU_SLOT_ID;
    const overflowMenu = document.createElement("div");
    const overflowSlot = document.createElement("div");
    overflowSlot.id = PRODUCTION_TOP_MENU_OVERFLOW_SLOT_ID;
    overflowMenu.appendChild(overflowSlot);
    document.body.append(toolbarSlot, overflowMenu);

    const closeOverflow = vi.fn(() => overflowMenu.classList.add("hidden"));
    await act(async () => root.render(
      <ProductionToolbarContext.Provider value={{
        stage: PRODUCTION_TOOLBAR_STAGE.primaryStored,
        closeOverflow,
        overflowOpen: true,
        hasStoredControls: true,
        setHasStoredControls: () => {},
      }}>
        <ProductionModuleTopMenu
          productionName="海边的剧"
          label="财务"
          primaryAction={<ExpenseCreateButton productionId="prod_1" baseCurrency="CNY" categories={[]} triggerVariant="toolbar" />}
          primaryShortAction={<ExpenseCreateButton productionId="prod_1" baseCurrency="CNY" categories={[]} triggerVariant="short" />}
          primaryOverflowAction={<ExpenseCreateButton productionId="prod_1" baseCurrency="CNY" categories={[]} triggerVariant="overflow" />}
        />
      </ProductionToolbarContext.Provider>,
    ));

    await act(async () => button("新建报销").click());

    expect(closeOverflow).toHaveBeenCalledTimes(1);
    expect(overflowMenu.classList.contains("hidden")).toBe(true);
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.closest(".hidden")).toBeNull();
    const titleInput = dialog!.querySelector<HTMLInputElement>('input[placeholder="例如：合成排练交通费"]')!;
    await act(async () => inputValue(titleInput, "窄屏报销"));
    expect(titleInput.value).toBe("窄屏报销");

    toolbarSlot.remove();
    overflowMenu.remove();
  });

  it("空白内容也能保存为服务端草稿", async () => {
    fetchMock.mockImplementation(() => jsonResponse({ expense: { id: "exp_draft" } }, 201));
    await act(async () => root.render(<ExpenseCreateButton productionId="prod_1" baseCurrency="CNY" categories={[]} />));
    await act(async () => button("＋ 新建报销").click());
    const submitEvent = new Event("submit", { bubbles: true, cancelable: true });
    Object.defineProperty(submitEvent, "submitter", { value: button("保存草稿") });
    await act(async () => document.querySelector("form")!.dispatchEvent(submitEvent));

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
        baseCurrency="CNY"
        categories={[{ id: "cat_1", name: "交通", deptName: "制作组" }]}
      />,
    ));

    await act(async () => button("＋ 新建报销").click());
    const inputs = [...document.querySelectorAll<HTMLInputElement>("input")];
    await act(async () => {
      inputValue(inputs[0], "合成排练打车");
      inputValue(inputs[1], "999999999999.99");
    });
    await act(async () => {
      document.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
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
    expect(document.querySelector("[role=dialog]")).toBeNull();
  });

  it("服务端拒绝时保留表单并显示原因", async () => {
    fetchMock.mockImplementation(() => jsonResponse({ error: "找不到这笔支出的审批人，请联系制作人" }, 409));
    await act(async () => root.render(<ExpenseCreateButton productionId="prod_1" baseCurrency="CNY" categories={[]} />));
    await act(async () => button("＋ 新建报销").click());
    const inputs = [...document.querySelectorAll<HTMLInputElement>("input")];
    await act(async () => {
      inputValue(inputs[0], "交通费");
      inputValue(inputs[1], "12.30");
      document.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });

    expect(document.querySelector("[role=dialog]")).not.toBeNull();
    expect(document.querySelector("[role=alert]")?.textContent).toContain("找不到这笔支出的审批人");
    expect(refresh).not.toHaveBeenCalled();
  });

  it("可以连续添加多份凭证并随报销一次提交", async () => {
    fetchMock.mockImplementation(() => jsonResponse({ expense: { id: "exp_docs" } }, 201));
    await act(async () => root.render(<ExpenseCreateButton productionId="prod_1" baseCurrency="CNY" categories={[]} />));
    await act(async () => button("＋ 新建报销").click());
    await act(async () => button("上传测试凭证").click());
    await act(async () => button("上传测试凭证").click());

    const inputs = [...document.querySelectorAll<HTMLInputElement>("input")];
    await act(async () => {
      inputValue(inputs[0], "两张发票");
      inputValue(inputs[1], "88.00");
      document.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });

    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body.documents).toEqual([
      { assetFileId: "af_1", kind: "invoice" },
      { assetFileId: "af_2", kind: "invoice" },
    ]);
  });

  it("把识别候选贴在对应输入框下，采用后只更新该字段", async () => {
    await act(async () => root.render(<ExpenseCreateButton productionId="prod_1" baseCurrency="CNY" categories={[]} />));
    await act(async () => button("＋ 新建报销").click());
    await act(async () => button("上传测试凭证").click());
    await act(async () => button("完成识别").click());

    const kindSelect = document.querySelector<HTMLSelectElement>('select[aria-label="票据1.pdf的凭证类型"]')!;
    const kindGroup = kindSelect.closest("div")!;
    expect(kindGroup.textContent).toContain("识别建议：收据");
    await act(async () => kindGroup.querySelector<HTMLButtonElement>("button")!.click());
    expect(kindSelect.value).toBe("receipt");
    expect(kindGroup.textContent).not.toContain("识别建议");

    const amountInput = document.querySelector<HTMLInputElement>('input[placeholder="0.00"]')!;
    const amountGroup = amountInput.closest("div")!;
    expect(amountGroup.textContent).toContain("识别建议：人民币（CNY） 88.50");
    expect(amountGroup.textContent).not.toContain("某某商店");

    await act(async () => amountGroup.querySelector<HTMLButtonElement>("button")!.click());
    expect(amountInput.value).toBe("88.50");
    expect(amountGroup.textContent).not.toContain("识别建议");
    expect(document.body.textContent).toContain("识别建议：某某商店");
    expect(document.body.textContent).toContain("识别建议：2026-09-30");
  });
});

describe("报销审批", () => {
  it("不能终局时显示“向上转交”，成功后刷新待办", async () => {
    fetchMock.mockImplementation(() => jsonResponse({ forwarded: true }));
    await act(async () => root.render(
      <ExpenseApprovalActions productionId="prod_1" expenseId="exp_1" canFinalize={false} mutationSeq={0}
        currentBudgetItemId={null} categories={[]} />,
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
      <ExpenseApprovalActions productionId="prod_1" expenseId="exp_1" canFinalize mutationSeq={0}
        currentBudgetItemId={null} categories={[]} />,
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

  it("当前审批人可以选择预算项并触发重新路由", async () => {
    fetchMock.mockImplementation(() => jsonResponse({ expense: { status: "pending" } }));
    await act(async () => root.render(
      <ExpenseApprovalActions productionId="prod_1" expenseId="exp_1" canFinalize mutationSeq={7}
        currentBudgetItemId="bi_old" categories={[
          { id: "bi_old", name: "搭建费", deptName: "舞美" },
          { id: "bi_new", name: "设备租赁费", deptName: "音响" },
        ]} />,
    ));

    const select = container.querySelector<HTMLSelectElement>('select[aria-label="调整预算项"]')!;
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
    await act(async () => {
      setter.call(select, "bi_new");
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => button("重新归类").click());

    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({
      action: "reclassify",
      budgetItemId: "bi_new",
      comment: "",
      expectedMutationSeq: 7,
    });
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});

describe("报销结清确认", () => {
  it("确认文案明确不发起支付，并提交当前 mutationSeq", async () => {
    const confirmMock = vi.spyOn(window, "confirm").mockReturnValue(true);
    fetchMock.mockImplementation(() => jsonResponse({ expense: { settledAt: "2026-10-01T00:00:00.000Z" } }));
    await act(async () => root.render(
      <ExpenseSettlementAction productionId="prod_1" expenseId="exp_1"
        settled={false} mutationSeq={4} />,
    ));

    await act(async () => button("标记已结清").click());
    expect(confirmMock).toHaveBeenCalledWith(expect.stringContaining("不会发起或验证支付"));
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({
      action: "settle", expectedMutationSeq: 4,
    });
    expect(refresh).toHaveBeenCalledTimes(1);
    confirmMock.mockRestore();
  });

  it("恢复待结清明确只是纠正记录", async () => {
    const confirmMock = vi.spyOn(window, "confirm").mockReturnValue(true);
    fetchMock.mockImplementation(() => jsonResponse({ expense: { settledAt: null } }));
    await act(async () => root.render(
      <ExpenseSettlementAction productionId="prod_1" expenseId="exp_1"
        settled mutationSeq={5} />,
    ));

    await act(async () => button("恢复待结清").click());
    expect(confirmMock).toHaveBeenCalledWith(expect.stringContaining("不代表任何款项被撤回"));
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({
      action: "reopen_settlement", expectedMutationSeq: 5,
    });
    confirmMock.mockRestore();
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
