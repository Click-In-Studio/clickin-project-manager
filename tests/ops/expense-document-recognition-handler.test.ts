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

  it("LLM 连接失败时立即落为失败且任务不再重排", async () => {
    mocks.recognize.mockRejectedValue(new Error("LLM connection failed"));
    const handler = getJobHandlerDef("expense_document_recognition");

    await expect(handler!.run({ assetFileId: "af_1" }, {} as JobRow))
      .rejects.toBeInstanceOf(TerminalJobError);

    expect(mocks.markProcessing).toHaveBeenCalledWith("af_1");
    expect(mocks.fail).toHaveBeenCalledWith("af_1", "failed", "LLM connection failed");
  });
});
