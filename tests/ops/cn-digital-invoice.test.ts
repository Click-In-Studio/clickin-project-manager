import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PdfDoc } from "@/lib/doc-extract/pdf";

const mocks = vi.hoisted(() => ({
  chat: vi.fn(),
  parsePdf: vi.fn(),
}));

vi.mock("@/lib/agent/llm-chat", () => ({
  chat: mocks.chat,
  configuredLlmModel: () => ({ provider: "openai", model: "fake-model" }),
}));

vi.mock("@/lib/asset/byte-source", () => ({
  r2ByteSource: () => ({}),
}));

vi.mock("@/lib/doc-extract/pdf", () => ({
  PDF_EXTRACTOR_VERSION: 2,
  parsePdf: mocks.parsePdf,
  readAll: async () => Buffer.from("fake-pdf"),
}));

vi.mock("@/lib/r2", () => ({ presignedGet: vi.fn() }));

import { parseCnDigitalInvoice } from "@/lib/ops/cn-digital-invoice";
import {
  expenseRecognitionVersions, recognizeExpenseDocument,
} from "@/lib/ops/expense-document-recognition";

const invoiceNumber = "26000000000000000001";

function invoiceDoc(): PdfDoc {
  return {
    pages: [{
      n: 1,
      width: 600,
      height: 800,
      vertical: false,
      status: "ok",
      lines: [
        { x: 120, y: 40, w: 450, text: `电 子 发 票（ 普 通 发 票 ） ⟨90⟩ 发 票 号 码：${invoiceNumber}` },
        { x: 420, y: 60, w: 150, text: "开 票 日 期：2026年03月04日" },
        { x: 30, y: 100, w: 520, text: "购 名称：示例采购方有限公司 ⟨120⟩ 销 名称：示例销售方有限公司" },
        { x: 30, y: 200, w: 520, text: "合 计 ⟨300⟩ ¥100.00 ⟨60⟩ ¥13.00" },
        { x: 30, y: 220, w: 520, text: "价税合计（大写）壹佰壹拾叁圆整 ⟨100⟩ （小写）¥113.00" },
      ],
    }],
    fontLegend: {},
    majorityFont: null,
    boilerplate: [],
    stats: {
      pageCount: 1,
      verticalPages: 0,
      blankPages: 0,
      rasterizedPages: 0,
      incompletePages: 0,
      assetsAvailable: true,
    },
  };
}

const file = {
  assetFileId: "af_fake",
  productionId: "prod_fake",
  uploaderUserId: "user_fake",
  r2Key: "fake/invoice.pdf",
  fileName: "示例发票.pdf",
  mimeType: "application/pdf",
  fileSize: 1024,
};

describe("中国数电发票确定性解析", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.parsePdf.mockResolvedValue(invoiceDoc());
    mocks.chat.mockRejectedValue(new Error("标准发票不应调用 LLM"));
  });

  it("从带异常空格和大间隙标记的标准票面提取强校验字段", () => {
    const result = parseCnDigitalInvoice(invoiceDoc());

    expect(result).toMatchObject({
      documentType: { value: "invoice", confidence: "high" },
      merchant: { value: "示例销售方有限公司", confidence: "high" },
      occurredOn: { value: "2026-03-04", confidence: "high" },
      documentNumber: { value: invoiceNumber, confidence: "high" },
      totalAmount: { value: "113.00", confidence: "high" },
      taxAmount: { value: "13.00", confidence: "high" },
      currency: { value: "CNY", confidence: "high" },
    });
  });

  it("标准发票命中后不调用 LLM", async () => {
    const recognized = await recognizeExpenseDocument(file);

    expect(recognized.result.totalAmount.value).toBe("113.00");
    expect(recognized.sourceKind).toBe("pdf_text");
    expect(mocks.chat).not.toHaveBeenCalled();
    expect(expenseRecognitionVersions().modelVersion).toContain("rules:cn-digital-invoice-v1");
  });

  it("购买方名称为空时仍按右侧名称提取销售方", () => {
    const doc = invoiceDoc();
    doc.pages[0].lines[2].text = "名称： ⟨120⟩ 名称：示例销售方有限公司";

    expect(parseCnDigitalInvoice(doc)?.merchant.value).toBe("示例销售方有限公司");
  });

  it("汇总单或金额校验不一致时拒绝快速路径", () => {
    const summary = invoiceDoc();
    summary.pages[0].lines[0].text += " 汇总单";
    expect(parseCnDigitalInvoice(summary)).toBeNull();

    const inconsistent = invoiceDoc();
    inconsistent.pages[0].lines[4].text = "价税合计（大写）壹佰圆整 （小写）¥100.00";
    expect(parseCnDigitalInvoice(inconsistent)).toBeNull();
  });

  it("非标准收据继续交给 LLM", async () => {
    const receipt = invoiceDoc();
    receipt.pages[0].lines = [
      { x: 20, y: 20, w: 300, text: "示例商店 收据" },
      { x: 20, y: 40, w: 300, text: "示例商品甲 1件 10.00元 示例商品乙 1件 15.00元" },
      { x: 20, y: 60, w: 300, text: "本次消费合计 25.00元 请妥善保管消费凭证" },
    ];
    mocks.parsePdf.mockResolvedValue(receipt);
    mocks.chat.mockResolvedValue(JSON.stringify({
      documentType: { value: "receipt", confidence: "high", evidence: "收据" },
      merchant: { value: "示例商店", confidence: "high", evidence: "示例商店" },
      occurredOn: { value: null, confidence: "low", evidence: null },
      documentNumber: { value: null, confidence: "low", evidence: null },
      totalAmount: { value: "25.00", confidence: "high", evidence: "合计" },
      taxAmount: { value: null, confidence: "low", evidence: null },
      currency: { value: "CNY", confidence: "high", evidence: "元" },
      warnings: [],
    }));

    const recognized = await recognizeExpenseDocument({ ...file, fileName: "示例收据.pdf" });

    expect(recognized.result.documentType.value).toBe("receipt");
    expect(mocks.chat).toHaveBeenCalledTimes(1);
  });
});
