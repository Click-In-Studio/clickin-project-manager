import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentAttachment } from "@/lib/agent/attachment-db";
import type { DocxDoc } from "@/lib/doc-extract/docx";
import type { PdfDoc } from "@/lib/doc-extract/pdf";
const state = vi.hoisted(() => ({
  objects: new Map<string, Buffer>(), files: new Map<string, Record<string, unknown>>(),
  docx: {} as DocxDoc, pdf: {} as PdfDoc, fail: false, expired: false,
  ocr: vi.fn(),
}));
vi.mock("@/lib/r2", () => ({
  putR2Object: async (key: string, body: Buffer) => { if (state.fail) throw new Error("保存失败"); state.objects.set(key, body); },
  getR2Object: async (key: string) => state.objects.has(key) ? { body: state.objects.get(key)! } : null,
  getR2Stream: async (key: string) => new Response(state.objects.get(key)?.toString("utf8") ?? ""),
  presignedGet: () => "https://r2.test/source",
}));
vi.mock("@/lib/agent/attachment-db", () => ({
  AGENT_ATTACHMENT_MAX_BYTES: 50 * 1024 * 1024,
  createPendingAttachment: vi.fn(async (input: Record<string, unknown>) => {
    const id = `a${state.files.size}`;
    const file = { ...input, id, r2Key: id, status: "pending", expiresAt: "2026-10-20", sourceMetadata: (input.source as { metadata: unknown })?.metadata };
    state.files.set(id, file); return file;
  }),
  markAttachmentReady: async (id: string) => { const file = { ...state.files.get(id), status: "ready" }; state.files.set(id, file); return file; },
  scheduleAttachmentDeletion: vi.fn(async () => true), recordAttachmentAccess: vi.fn(),
  getReadyAttachmentForSession: async (id: string, session: string, user: string) => !state.expired && session === "session" && user === "owner" ? state.files.get(id) : null,
  getAttachmentForSession: async () => state.expired ? { status: "deleting" } : null,
}));
vi.mock("@/lib/doc-extract/load", () => ({
  loadParsedDocx: async () => ({ status: "ok", doc: state.docx }),
  loadParsedPdf: async () => ({ status: "ok", doc: state.pdf }),
}));
vi.mock("@/lib/mmp/ocr", () => ({ ocrPages: state.ocr }));
vi.mock("@/lib/mmp/usage-db", () => ({ recordMmpUsage: vi.fn() }));
import { attachmentDocRead, attachmentFileOcr } from "@/lib/agent/tools/doc-tools";
import { saveWebPage } from "@/lib/agent/tools/web-fetch-tools";
import { saveTextResult } from "@/lib/agent/tools/result-attachment";
import { readModelMedia } from "@/lib/agent/runtime/model-read";
import { readResourceText } from "@/lib/agent/tools/media-read-tools";
import { createStreamLineAdapter } from "@/lib/agent/runtime/stream-lines";
import type { StreamLine } from "@/lib/agent/chat/stream-reducer";
import { createPendingAttachment, scheduleAttachmentDeletion } from "@/lib/agent/attachment-db";
const context = { userId: "owner", sessionId: "session", runId: "run", toolCallId: "call" };
const file = { fileId: "file", fileName: "source.docx", r2Key: "file", fileSize: 100 };
beforeEach(() => { state.objects.clear(); state.files.clear(); state.fail = false; state.expired = false; vi.clearAllMocks(); });

describe("同一份长材料可定位并读回", () => {
  it("长网页保存完整快照，摘要外的后段可搜索和窗口读回；跨会话拒绝", async () => {
    const body = "开头".repeat(15000) + "网页后段关键证据";
    const preview = await saveWebPage(context, { requestedUrl: "https://test/start", url: "https://test/final", fetchedAt: "2026-10-19T00:00:00Z", title: "资料", text: body, truncated: true });
    expect(JSON.stringify(preview)).toContain("attachmentId=a0"); expect(JSON.stringify(preview)).not.toContain("网页后段关键证据");
    expect(preview.details?.attachments[0]).toMatchObject({ attachmentId: "a0", mimeType: "text/plain" });
    const lines: StreamLine[] = [];
    createStreamLineAdapter(line => lines.push(line))({ type: "tool_execution_end", toolCallId: "call", toolName: "web.fetch", result: preview, isError: false });
    expect(lines.find(line => line.type === "tool-result")).toMatchObject({ attachments: [{ id: "a0", fileName: "web-page.txt", status: "ready" }] });
    const saved = state.files.get("a0") as unknown as AgentAttachment;
    expect(state.objects.get("a0")!.toString()).toContain(body);
    expect(saved.sourceMetadata).toMatchObject({ fetchedAt: "2026-10-19T00:00:00Z" });
    const search = await readResourceText(saved, { mode: "search", query: "网页后段关键证据" }, { ...context, productionId: null });
    const located = JSON.parse(search.text.slice(search.text.indexOf("\n") + 1));
    const result = await readModelMedia({ userId: "owner", productionId: null, run: { sessionId: "session", runId: "run" } } as Parameters<typeof readModelMedia>[0], { attachmentId: "a0", window: { offset: located.matches[0].offset, length: 100 } });
    expect(JSON.stringify(result)).toContain("网页后段关键证据");
    const denied = await readModelMedia({ userId: "outsider", productionId: null, run: { sessionId: "other" } } as Parameters<typeof readModelMedia>[0], { attachmentId: "a0", window: { offset: 0 } });
    expect(JSON.stringify(denied)).toContain("没有找到");
    state.expired = true;
    const expired = await readModelMedia({ userId: "owner", productionId: null, run: { sessionId: "session" } } as Parameters<typeof readModelMedia>[0], { attachmentId: "a0", window: { offset: 0 } });
    expect(JSON.stringify(expired)).toContain("已过期");
  });
  it("保存失败不会返回虚假原件引用，并进入已有清理流程", async () => {
    state.fail = true;
    await expect(saveTextResult({ ...context, fileName: "text.txt", mimeType: "text/plain", text: "原件" })).rejects.toThrow("保存失败");
    expect(scheduleAttachmentDeletion).toHaveBeenCalledWith("a0", "session", "owner");
  });
  it("重试复用时，预览来自已保存快照", async () => {
    state.objects.set("old", Buffer.from("已保存的第一次内容"));
    vi.mocked(createPendingAttachment).mockResolvedValueOnce({ id: "old", r2Key: "old", status: "ready", fileName: "web-page.txt" } as AgentAttachment);
    const saved = await saveTextResult({ ...context, fileName: "text.txt", mimeType: "text/plain", text: "第二次不同内容" });
    expect(saved.text).toBe("已保存的第一次内容");
  });
  it("DOCX 长段、表格后行长单元格和长脚注都能精读", async () => {
    state.docx = { items: [{ kind: "p", text: "甲".repeat(1500) + "段末证据" }, { kind: "table", rows: Array.from({ length: 65 }, () => ["乙".repeat(800) + "格末证据"]) }], footnotes: { n1: "丙".repeat(9000) + "脚注末尾" } } as unknown as DocxDoc;
    const initial = await attachmentDocRead(file, { mode: "read", ranges: [{ from: 0, to: 1 }] });
    expect(initial).not.toContain("段末证据"); expect(initial).toContain("window=");
    expect(await attachmentDocRead(file, { window: { block: 0, offset: 1500 } })).toContain("段末证据");
    expect(await attachmentDocRead(file, { window: { block: 1, row: 64, column: 0, offset: 800 } })).toContain("格末证据");
    expect(await attachmentDocRead(file, { window: { noteId: "n1", offset: 9000 } })).toContain("脚注末尾");
    expect(await attachmentDocRead(file, { mode: "search", query: "格末证据" })).toContain("格末证据");
  });
  it("PDF 超长行及第401行可直接细读，不反复返回同一页前缀", async () => {
    state.pdf = { stats: { pageCount: 1 }, pages: [{ n: 1, status: "ok", lines: Array.from({ length: 401 }, (_, i) => ({ x: 0, text: i === 400 ? "最后一行证据" : i === 0 ? "甲".repeat(1500) + "长行后段" : "行" })) }] } as unknown as PdfDoc;
    const pdf = { ...file, fileName: "file.pdf" };
    expect(await attachmentDocRead(pdf, { window: { page: 1, line: 0, offset: 1500 } })).toContain("长行后段");
    expect(await attachmentDocRead(pdf, { window: { page: 1, line: 400 } })).toContain("最后一行证据");
  });
  it("长 OCR 保存本次完整结果，后文直接回查而非重跑识别", async () => {
    state.ocr.mockResolvedValue({ status: "ok", cached: true, tier: "gpu-fast", engine: "test", jobId: "ocr-job", pages: [{ page: 1, tier: "gpu-fast", text: "字".repeat(25000) + "识别末尾", quality: { lines: 1 }, flags: [] }], suggestUpgradePages: [] });
    const preview = await attachmentFileOcr("owner", null, { ...file, fileName: "scan.png" }, "image/png", [1], context);
    expect(JSON.stringify(preview)).toContain("attachmentId=a0"); expect(JSON.stringify(preview)).not.toContain("识别末尾");
    expect(typeof preview !== "string" && preview.details?.attachments[0]).toMatchObject({ attachmentId: "a0", mimeType: "application/json" });
    expect(state.objects.get("a0")!.toString()).toContain("识别末尾");
    const saved = state.files.get("a0") as unknown as AgentAttachment;
    const read = await readResourceText(saved, { mode: "search", query: "识别末尾" }, { ...context, productionId: null });
    expect(read.text).toContain("识别末尾"); expect(state.ocr).toHaveBeenCalledTimes(1);
  });
});
