import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeProduction, cleanupProduction } from "../_support/factories";
import { createAsset } from "@/lib/asset/db";
import { getPool } from "@/lib/pg";
import { expenseRecognitionVersions } from "@/lib/ops/expense-document-recognition";
import { finishExpenseDocumentRecognition, getExpenseDocumentRecognition, queueExpenseDocumentRecognitionRow } from "@/lib/ops/expense-recognition-db";
import { parseRecognitionJson } from "@/lib/ops/expense-document-recognition";
let prodId: string;
let fileId: string;
beforeAll(async () => {
  ({ prodId } = await makeProduction());
  const owner = (await getPool().query<{ owner_id: string }>("SELECT owner_id FROM production WHERE id=$1", [prodId])).rows[0].owner_id;
  const document = await createAsset({ productionId: prodId, uploaderUserId: owner, assetType: "financial_document", fileName: "虚构票据.pdf", mimeType: "application/pdf", storageType: "r2", r2Key: `test/${prodId}/receipt.pdf`, listable: false, fileVersionPolicy: "single", grantUploader: false });
  fileId = document.file.id;
});
afterAll(async () => { await cleanupProduction(prodId).catch(() => {}); });
describe("凭证识别策略版本与实际生成模型", () => {
  it("备用成功落库后保持有效，同策略入队不清掉结果，显式重试仍可入队", async () => {
    const versions = expenseRecognitionVersions();
    await queueExpenseDocumentRecognitionRow(fileId, versions);
    const field = { value: null, confidence: "low", evidence: null };
    const result = parseRecognitionJson(JSON.stringify({ documentType: { ...field, value: "receipt" }, merchant: field, occurredOn: field, documentNumber: field, totalAmount: { ...field, value: "36.50" }, taxAmount: field, currency: { ...field, value: "CNY" }, warnings: [] }));
    const actual = `${versions.modelVersion}|served:qwen:qwen3.8-flash`;
    await finishExpenseDocumentRecognition(fileId, "pdf_text", result, actual);
    expect(await getExpenseDocumentRecognition(fileId, versions)).toMatchObject({ status: "succeeded", modelVersion: actual, outdated: false, result: { totalAmount: { value: "36.50" } } });
    await queueExpenseDocumentRecognitionRow(fileId, versions);
    expect(await getExpenseDocumentRecognition(fileId, versions)).toMatchObject({ status: "succeeded", modelVersion: actual });
    await queueExpenseDocumentRecognitionRow(fileId, versions, true);
    expect(await getExpenseDocumentRecognition(fileId, versions)).toMatchObject({ status: "queued", result: null });
  });
});
