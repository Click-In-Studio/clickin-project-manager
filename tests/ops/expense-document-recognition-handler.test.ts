import { beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalJobError, type JobRow } from "@/lib/job/queue";

const mocks = vi.hoisted(() => ({
  fail: vi.fn(),
  finish: vi.fn(),
  getFile: vi.fn(),
  markProcessing: vi.fn(),
  recognize: vi.fn(),
}));

vi.mock("@/lib/ops/expense-recognition-db", () => ({
  failExpenseDocumentRecognition: mocks.fail,
  finishExpenseDocumentRecognition: mocks.finish,
  markExpenseDocumentRecognitionProcessing: mocks.markProcessing,
}));

vi.mock("@/lib/ops/finance-document-db", () => ({
  getFinancialDocumentFile: mocks.getFile,
}));

vi.mock("@/lib/ops/expense-document-recognition", () => ({
  RecognitionUnavailableError: class RecognitionUnavailableError extends Error {},
  recognizeExpenseDocument: mocks.recognize,
}));

import { getJobHandlerDef } from "@/lib/job/handlers";

describe("财务凭证识别任务", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getFile.mockResolvedValue({ id: "af_1" });
  });

  it("非供应商的业务异常终止任务，不重复生成", async () => {
    mocks.recognize.mockRejectedValue(new Error("凭证解析异常"));
    const handler = getJobHandlerDef("expense_document_recognition");

    await expect(handler!.run({ assetFileId: "af_1" }, {} as JobRow))
      .rejects.toBeInstanceOf(TerminalJobError);

    expect(mocks.markProcessing).toHaveBeenCalledWith("af_1");
    expect(mocks.fail).toHaveBeenCalledWith("af_1", "failed", "凭证解析异常");
  });

  it("全部模型不可用时落为 unavailable，不冒充凭证解析失败", async () => {
    const { RecognitionUnavailableError } = await import("@/lib/ops/expense-document-recognition");
    mocks.getFile.mockResolvedValue({ id: "af_1" });
    mocks.recognize.mockRejectedValue(new RecognitionUnavailableError("智能处理服务暂不可用"));
    await expect(getJobHandlerDef("expense_document_recognition")!.run({ assetFileId: "af_1" }, {} as JobRow)).resolves.toMatchObject({ unavailable: true });
    expect(mocks.fail).toHaveBeenCalledWith("af_1", "unavailable", "智能处理服务暂不可用");
  });
  it("成功记录实际模型，提交失败不重新生成", async () => {
    mocks.getFile.mockResolvedValue({ id: "af_1" });
    mocks.recognize.mockResolvedValue({ sourceKind: "pdf_text", result: {}, modelVersion: "policy|served:qwen:qwen3.8-flash" });
    mocks.finish.mockRejectedValueOnce(new Error("db write failed"));
    const count = mocks.recognize.mock.calls.length;
    await expect(getJobHandlerDef("expense_document_recognition")!.run({ assetFileId: "af_1" }, {} as JobRow)).rejects.toBeInstanceOf(TerminalJobError);
    expect(mocks.recognize.mock.calls.length - count).toBe(1);
    expect(mocks.finish).toHaveBeenCalledWith("af_1", "pdf_text", {}, "policy|served:qwen:qwen3.8-flash");
  });

});
