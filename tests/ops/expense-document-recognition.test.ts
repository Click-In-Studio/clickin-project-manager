import { describe, expect, it } from "vitest";
import { getJobHandlerDef } from "@/lib/job/handlers";
import { parseRecognitionJson } from "@/lib/ops/expense-document-recognition";

describe("财务凭证结构化识别", () => {
  it("兼容代码块并规范金额、日期和币种", () => {
    const result = parseRecognitionJson(`\`\`\`json
      {
        "documentType":{"value":"receipt","confidence":"high","evidence":"收据"},
        "merchant":{"value":" 某某商店 ","confidence":"medium","evidence":"销售方：某某商店"},
        "occurredOn":{"value":"2026-09-30","confidence":"high","evidence":"日期"},
        "documentNumber":{"value":null,"confidence":"low","evidence":null},
        "totalAmount":{"value":"¥ 1,280.50","confidence":"high","evidence":"合计"},
        "taxAmount":{"value":"80.50","confidence":"medium","evidence":"税额"},
        "currency":{"value":"cny","confidence":"high","evidence":"人民币"},
        "warnings":[]
      }
    \`\`\``);
    expect(result.documentType.value).toBe("receipt");
    expect(result.merchant.value).toBe("某某商店");
    expect(result.occurredOn.value).toBe("2026-09-30");
    expect(result.totalAmount.value).toBe("1280.50");
    expect(result.currency.value).toBe("CNY");
  });

  it("拒绝模型编造的非法枚举、日期与金额", () => {
    const field = { value: null, confidence: "low", evidence: null };
    const result = parseRecognitionJson(JSON.stringify({
      documentType: { value: "contract", confidence: "high", evidence: "猜测" },
      merchant: field,
      occurredOn: { value: "2026-02-31", confidence: "high", evidence: "错误日期" },
      documentNumber: field,
      totalAmount: { value: "一百元", confidence: "high", evidence: "中文金额" },
      taxAmount: field,
      currency: field,
      warnings: ["请人工核对"],
    }));
    expect(result.documentType).toMatchObject({ value: "other", confidence: "low" });
    expect(result.occurredOn.value).toBeNull();
    expect(result.totalAmount.value).toBeNull();
  });

  it("生产 handler 注册表包含识别任务", () => {
    expect(getJobHandlerDef("expense_document_recognition")).not.toBeNull();
  });
});
