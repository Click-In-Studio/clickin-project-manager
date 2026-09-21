// #453 doc_page_ocr：门与 doc_* 同源（非成员 / 无 meta 票拒绝）、格式门、MMP 未配置时的
// 诚实降级（不是报错、不是当空页），以及三处注册（DEFS / catalog / labels / tiers）的静态断言。
// 真 OCR 往返在 tests/agent/mmp-ocr.test.ts 用假 fetch 钉；这里不打服务。

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { makeProduction, cleanupProduction, shortId } from "../_support/factories";
import { upsertFeishuUser, addProductionMember } from "@/lib/db";
import { createAsset } from "@/lib/asset/db";
import { docPageOcr, DENIED_ASSET_VIEW } from "@/lib/agent/tools/doc-tools";
import { DENIED_NOT_MEMBER } from "@/lib/agent/tools/production-tools";
import { DEFS } from "@/lib/agent/runtime/tools";
import { TOOL_CATALOG } from "@/lib/agent/tools/tool-catalog";
import { TOOL_LABELS } from "@/lib/agent/agent-tool-labels";
import { recordMmpUsage } from "@/lib/mmp/billing";
import { getPool } from "@/lib/pg";

let prodId: string;
let ownerId: string;
let memberId: string;
let outsiderId: string;

async function makeUser(tag: string): Promise<string> {
  return (await upsertFeishuUser(`test-open-${shortId()}`, `${tag}-${shortId()}`, null, false)).userId;
}

async function makeAsset(fileName: string, mimeType: string | null, r2Key: string | null = `test/${shortId()}/${fileName}`): Promise<string> {
  const { asset } = await createAsset({
    productionId: prodId, uploaderUserId: ownerId, assetType: "reference",
    fileName, mimeType, storageType: "r2", isPublic: false, r2Key, fileSize: 1234,
  });
  return asset.id;
}

const ENV_BEFORE = { url: process.env.MMP_BASE_URL };

beforeAll(async () => {
  ownerId = await makeUser("ocr-owner");
  memberId = await makeUser("ocr-member");
  outsiderId = await makeUser("ocr-outsider");
  ({ prodId } = await makeProduction(ownerId));
  await addProductionMember(prodId, memberId);
});

afterAll(async () => {
  if (ENV_BEFORE.url === undefined) delete process.env.MMP_BASE_URL; else process.env.MMP_BASE_URL = ENV_BEFORE.url;
  await cleanupProduction(prodId).catch(() => {});
});

describe("doc_page_ocr：门", () => {
  it("非成员 → DENIED_NOT_MEMBER；无 meta 票的成员 → DENIED_ASSET_VIEW", async () => {
    const assetId = await makeAsset("scan.pdf", "application/pdf");
    expect(await docPageOcr(outsiderId, prodId, assetId, [1])).toBe(DENIED_NOT_MEMBER);
    expect(await docPageOcr(memberId, prodId, assetId, [1])).toBe(DENIED_ASSET_VIEW);
  });

  it("不支持的格式 / 空 pages 明确回话，不打服务", async () => {
    delete process.env.MMP_BASE_URL;
    const docx = await makeAsset("script.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    expect(await docPageOcr(ownerId, prodId, docx, [1])).toContain("无法做 OCR");
    const png = await makeAsset("photo.png", "image/png");
    expect(await docPageOcr(ownerId, prodId, png, [])).toContain("pages 不能为空");
  });

  it("MMP 未配置 → 诚实标注不可用，且明说不是页面为空（图片文件不经 pdf 解析直接到服务）", async () => {
    delete process.env.MMP_BASE_URL;
    const png = await makeAsset("photo.png", "image/png");
    const out = await docPageOcr(ownerId, prodId, png, [1]);
    expect(out).toContain("OCR 服务当前不可用");
    expect(out).toContain("not_configured");
    expect(out).toContain("不要把这当作页面为空");
  });
});

describe("doc_page_ocr：注册点", () => {
  it("DEFS / catalog / labels 三处都有，且在 production.doc 族", () => {
    const def = DEFS.find((d) => d.mcpName === "production.doc_page_ocr");
    expect(def).toBeTruthy();
    expect(def?.readOnly).toBe(true);
    expect(def?.needsProduction).toBe(true);
    const cat = TOOL_CATALOG.find((c) => c.name === "production.doc_page_ocr");
    expect(cat?.family).toBe("production.doc");
    expect(cat?.triggers).toContain("扫描件");
    expect(TOOL_LABELS["production-doc_page_ocr"]).toBeTruthy();
  });
});

describe("recordMmpUsage（#618）", () => {
  it("落一行 ai_usage：kind=mmp_compute、model=mmp:<type>@<tier>、tokens=推理毫秒；cpu 档 0 credit 照记", async () => {
    const gpu = await recordMmpUsage({ userId: ownerId, productionId: prodId, type: "ocr.structured", tier: "gpu", computeMs: 2547 });
    expect(gpu).toBeGreaterThan(500);
    const cpu = await recordMmpUsage({ userId: ownerId, productionId: prodId, type: "triage.audio", tier: "cpu", computeMs: 1500 });
    expect(cpu).toBe(0);
    const { rows } = await getPool().query<{ kind: string; model: string; tokens: number; billed_credits: string; paid_from: string }>(
      `SELECT kind, model, tokens, billed_credits::text, paid_from FROM ai_usage
       WHERE production_id = $1 AND kind = 'mmp_compute' ORDER BY id`,
      [prodId],
    );
    expect(rows.map((r) => [r.kind, r.model, r.tokens, Number(r.billed_credits)])).toEqual([
      ["mmp_compute", "mmp:ocr.structured@gpu", 2547, gpu],
      ["mmp_compute", "mmp:triage.audio@cpu", 1500, 0],
    ]);
    expect(["quota", "extra", "exempt"]).toContain(rows[0].paid_from);
  });
});
