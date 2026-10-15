import { estimateRequestBudget } from "@/lib/agent/runtime/context-budget";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { readModelMedia } from "@/lib/agent/runtime/model-read";
import { restoreModelMedia } from "@/lib/agent/runtime/model-media-state";
import { resolveModel } from "@/lib/agent/runtime/config";
import { tieredToolNames } from "@/lib/agent/runtime/tool-tiers";
import { TOOL_MCP_NAMES, buildTools } from "@/lib/agent/runtime/tools";

const state = vi.hoisted(() => ({
  attachment: null as unknown, asset: null as unknown, modelKey: "deepseek-flash", preflight: vi.fn(), doc: vi.fn(),
  textBody: "完整的文本材料", getAttachment: vi.fn(), resolveAsset: vi.fn(), access: vi.fn(),
}));
vi.mock("@/lib/agent/attachment-db", () => ({
  getReadyAttachmentForSession: state.getAttachment,
  getAttachmentForSession: async () => null,
  recordAttachmentAccess: state.access,
  listAttachmentsForSession: async () => state.attachment ? [state.attachment] : [],
  getReadyAttachments: async () => state.attachment ? [state.attachment] : [],
}));
vi.mock("@/lib/agent/tools/doc-tools", () => ({ resolveReadableAsset: state.resolveAsset,
  attachmentDocRead: state.doc, attachmentFileOcr: vi.fn() }));
vi.mock("@/lib/agent/runtime/model-settings-db", () => ({ runModelSelection: async () => ({ modelKey: state.modelKey }) }));
vi.mock("@/lib/mmp/attachment-preflight", () => ({ preflightAttachment: state.preflight }));
vi.mock("@/lib/r2", () => ({ presignedGet: () => "https://media.test/immutable", getR2Object: async () => ({ body: Buffer.from(state.textBody) }) }));
const run = { runId: "r", sessionId: "s", signal: new AbortController().signal, publish: () => {}, setStatus: async () => {}, isDetached: () => false };
const context = { userId: "u", productionId: "p", run };

beforeEach(async () => {
  vi.clearAllMocks();
  state.modelKey = "deepseek-flash";
  state.textBody = "完整的文本材料";
  const bytes = await sharp({ create: { width: 10, height: 10, channels: 3, background: "blue" } }).png().toBuffer();
  state.attachment = { id: "att", mimeType: "image/png", mediaKind: "image", fileSize: bytes.length, fileName: "图片.png", r2Key: "object" };
  state.asset = { asset: { id: "asset", mimeType: "image/png", fileName: "图片.png" }, file: { id: "file", fileSize: bytes.length, r2Key: "object" } };
  state.getAttachment.mockImplementation(async () => state.attachment);
  state.resolveAsset.mockImplementation(async () => state.asset);
  state.preflight.mockResolvedValue({ status: "ok", contextText: "MMP 描述：蓝色画面" });
  state.doc.mockResolvedValue("文档概览：共三页，正文按 ranges 读取。");
  vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array(bytes))));
});
afterEach(() => vi.unstubAllGlobals());

describe("#967 附件与素材同构读取", () => {
  it("长曲谱可按字符区间完整回查，不把部分内容标成完整已读", async () => {
    state.textBody = "甲".repeat(80_000) + "乙".repeat(20_000);
    state.attachment = { ...(state.attachment as object), mimeType: "text/plain", fileName: "score.txt", mediaKind: null, fileSize: 300_000 };
    const result = await readModelMedia(context, { attachmentId: "att", mode: "read", ranges: [{ from: 80_000, to: 100_000 }] });
    expect(JSON.stringify(result.content)).toContain("乙".repeat(20_000));
    expect(JSON.stringify(result.content)).not.toContain("甲");
    expect(result.details).toEqual({ completeAttachmentIds: [] });
    const invalid = await readModelMedia(context, { attachmentId: "att", mode: "read", ranges: [{ from: 0, to: 100_001 }] });
    expect(JSON.stringify(invalid.content)).toContain("区间需满足");
  });

  it("产物来源在原生读取及 MMP 路径都保留，不把请求区间伪装成实际区间", async () => {
    state.attachment = { ...(state.attachment as object), sourceMetadata: { inputs: { audio: { attachmentId: "original" }, options: { start_sec: 12, end_sec: 13 } } } };
    const native = await readModelMedia(context, { attachmentId: "att" });
    expect(JSON.stringify(native)).toContain("original");
    state.modelKey = "deepseek-pro";
    const fallback = await readModelMedia(context, { attachmentId: "att" });
    expect(JSON.stringify(fallback)).toContain("start_sec");
  });

  it.each(["attachment", "asset"])("%s 原生可读时直接返回原件，不调用 MMP", async (kind) => {
    const args = kind === "asset" ? { assetId: "asset" } : { attachmentId: "att" };
    const result = await readModelMedia(context, args);
    expect(result.content).toContainEqual(expect.objectContaining({ type: "image", ...args, data: expect.any(String) }));
    expect(state.preflight).not.toHaveBeenCalled();
    if (kind === "asset") expect(result.content[1]).toMatchObject({ source: { kind: "asset", fileId: "file" } });
  });

  it.each(["attachment", "asset"])("%s 模态不支持时只走 MMP，未伪称原生理解", async (kind) => {
    state.modelKey = "deepseek-pro";
    const result = await readModelMedia(context, kind === "asset" ? { assetId: "asset" } : { attachmentId: "att" });
    expect(result.content.every((part) => part.type === "text")).toBe(true);
    expect(JSON.stringify(result)).toContain("当前模型未原生读取");
    expect(state.preflight).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["attachment", "asset"])("%s 显式读取先等待历史整理；确认无法容纳才走 MMP，摘要失败不伪装成成功", async (kind) => {
    const args = kind === "asset" ? { assetId: "asset" } : { attachmentId: "att" };
    const prepare = vi.fn(async () => false);
    const ctx = { ...context, run: { ...run, prepareMediaRead: prepare } };
    const fallback = await readModelMedia(ctx, args);
    expect(prepare).toHaveBeenCalledWith(expect.objectContaining({ type: "image", data: expect.any(String) }));
    expect(state.preflight).toHaveBeenCalledOnce();
    expect(fallback.content.every((part) => part.type === "text")).toBe(true);
    state.preflight.mockClear();
    prepare.mockRejectedValueOnce(new Error("摘要模型不可用"));
    await expect(readModelMedia(ctx, args)).rejects.toThrow("摘要模型不可用");
    expect(state.preflight).not.toHaveBeenCalled();
  });

  it("原件本身超限时直接 MMP，不为了不可能的原生输入反复压缩", async () => {
    state.attachment = { ...(state.attachment as object), fileSize: 30 * 1024 * 1024 };
    const result = await readModelMedia(context, { attachmentId: "att" });
    expect(result.content.every((part) => part.type === "text")).toBe(true);
    expect(state.preflight).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("不支持的 DOCX 走现有概览；概览不能标为完整附件已读", async () => {
    state.attachment = { ...(state.attachment as object), mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", fileName: "剧本.docx" };
    const result = await readModelMedia(context, { attachmentId: "att" });
    expect(state.doc).toHaveBeenCalledOnce();
    expect(state.preflight).not.toHaveBeenCalled();
    expect(result.details).toEqual({ completeAttachmentIds: [] });
  });

  it("完整纯文本结果明确标记覆盖，避免仅凭清单或预检省掉读取工具", async () => {
    state.attachment = { ...(state.attachment as object), mimeType: "text/plain", fileName: "说明.txt", mediaKind: null };
    const result = await readModelMedia(context, { attachmentId: "att" });
    expect(result.details).toEqual({ completeAttachmentIds: ["att"] });
  });

  it("伪造附件和无权素材在获取原件/MMP之前拒绝", async () => {
    state.attachment = null;
    state.asset = "权限被拒绝：你没有查看该资产的权限。";
    expect(JSON.stringify(await readModelMedia(context, { attachmentId: "forged" }))).toContain("不属于当前会话");
    expect(JSON.stringify(await readModelMedia(context, { assetId: "private" }))).toContain("权限被拒绝");
    expect(state.getAttachment).toHaveBeenCalledWith("forged", "s", "u");
    expect(state.resolveAsset).toHaveBeenCalledWith("u", "p", "private");
    expect(fetch).not.toHaveBeenCalled();
    expect(state.preflight).not.toHaveBeenCalled();
  });

  it("已生成图片只有持久引用时，也按已校验像素/字节触发模型适配，不能静默丢掉", async () => {
    const result = await readModelMedia(context, { attachmentId: "att" });
    const native = result.content.find((part) => part.type === "image")!;
    if (native.type !== "image") throw new Error("未获得原件");
    state.attachment = { ...(state.attachment as object), sourceMetadata: { width: 10, height: 10 } };
    const model = resolveModel("deepseek-pro");
    const messages = await restoreModelMedia([{ role: "user", timestamp: 1, content: [{ ...native, data: undefined, budget: undefined }] }],
      { userId: "u", sessionId: "s", productionId: "p", runId: "r", signal: run.signal, model });
    expect(JSON.stringify(messages)).toContain('"type":"image"');
    expect(JSON.stringify(messages)).not.toContain('"data":');
    expect(estimateRequestBudget(model, { messages: messages as Parameters<typeof estimateRequestBudget>[1]["messages"] }).mediaFits).toBe(false);
  });

  it("素材原件每次恢复都复核权限和文件版本，不能用当前文件替换历史证据", async () => {
    const result = await readModelMedia(context, { assetId: "asset" });
    const messages = [{ role: "user" as const, timestamp: 1, content: result.content }];
    const input = { userId: "u", sessionId: "s", productionId: "p", runId: "r", signal: run.signal, model: resolveModel("deepseek-flash") };
    state.asset = "权限被拒绝";
    const revoked = await restoreModelMedia(messages, input);
    expect(JSON.stringify(revoked)).toContain("权限被拒绝");
    expect(JSON.stringify(revoked)).not.toContain('"data":');
    state.asset = { asset: { id: "asset", fileName: "新版.png", mimeType: "image/png" }, file: { id: "new-file", fileSize: 1, r2Key: "new-object" } };
    await expect(restoreModelMedia(messages, input)).rejects.toThrow("原件版本变化");
  });

  it("素材读取在 Wiki/素材页进入温层，其他页面走召回；预检旧别名不再注册", () => {
    for (const pageKey of ["prod:wiki", "prod:assets"]) {
      const tier = tieredToolNames({ hasProduction: true, pageKey, prompt: null, recalled: [], available: TOOL_MCP_NAMES });
      expect(tier.warm).toContain("production.asset_read");
    }
    const elsewhere = { hasProduction: true, pageKey: "prod:home", prompt: null, recalled: [], available: TOOL_MCP_NAMES };
    expect(tieredToolNames(elsewhere).active).not.toContain("production.asset_read");
    expect(tieredToolNames({ ...elsewhere, recalled: ["production.asset_read"] }).active).toContain("production.asset_read");
    expect(buildTools(context).some((tool) => tool.mcpName === "production.asset_preflight")).toBe(false);
    expect(tieredToolNames(elsewhere).hot).not.toContain("my.attachment_read");
  });
});
