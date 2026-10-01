// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExpenseRecognitionSuggestions } from "@/components/ops/ExpenseRecognitionSuggestions";
import type { ExpenseDocumentRecognition } from "@/lib/ops/expense-recognition-types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const recognition: ExpenseDocumentRecognition = {
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
    documentNumber: { value: "R-1", confidence: "medium", evidence: "编号" },
    totalAmount: { value: "88.50", confidence: "high", evidence: "合计" },
    taxAmount: { value: null, confidence: "low", evidence: null },
    currency: { value: "CNY", confidence: "high", evidence: "人民币" },
    warnings: [],
  },
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("凭证识别建议", () => {
  it("异步完成后用非阻塞提示让用户决定是否填入", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => ({ recognition }),
    })));
    const applied = vi.fn();
    const typeApplied = vi.fn();
    let currentRecognition: ExpenseDocumentRecognition | null = null;
    const render = () => root.render(
      <ExpenseRecognitionSuggestions
        productionId="prod_1"
        documents={[{
          assetId: "ast_1", assetFileId: "af_1", fileName: "收据.pdf",
          recognition: currentRecognition,
        }]}
        current={{ amount: "", merchant: "", occurredOn: "" }}
        onRecognition={(_fileId, next) => { currentRecognition = next; render(); }}
        onApply={applied}
        onDocumentType={typeApplied}
      />,
    );
    await act(async () => { render(); await Promise.resolve(); await Promise.resolve(); });

    const notice = container.querySelector<HTMLElement>("[role=status]");
    expect(notice?.textContent).toContain("识别完成");
    expect(container.querySelector("[aria-modal=true]")).toBeNull();
    expect(container.textContent).toContain("来源：PDF 文本层");
    expect([...container.querySelectorAll("button")].some(button => button.textContent?.includes("收起"))).toBe(true);
    await act(async () => {
      [...notice!.querySelectorAll("button")].find(button => button.textContent === "填入")!.click();
    });
    expect(applied.mock.calls).toEqual([
      ["merchant", "某某商店"],
      ["occurredOn", "2026-09-30"],
      ["amount", "88.50"],
    ]);
    expect(typeApplied).toHaveBeenCalledWith("af_1", "receipt");
  });

  it("已有金额冲突时默认展开建议且不覆盖输入", async () => {
    const applied = vi.fn();
    await act(async () => root.render(
      <ExpenseRecognitionSuggestions
        productionId="prod_1"
        documents={[{ assetId: "ast_1", assetFileId: "af_1", fileName: "发票.pdf", recognition }]}
        current={{ amount: "100.00", merchant: "", occurredOn: "" }}
        onRecognition={() => {}}
        onApply={applied}
      />,
    ));
    expect([...container.querySelectorAll("button")].some(button => button.textContent?.includes("收起"))).toBe(true);
    expect(container.textContent).toContain("票面合计 ¥88.50 与当前报销金额 ¥100.00 不一致");
    expect(applied).not.toHaveBeenCalled();
  });
});
