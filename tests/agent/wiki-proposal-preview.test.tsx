// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import WikiProposalPreviewModal from "@/components/agent/WikiProposalPreviewModal";

vi.mock("@/components/wiki/WikiMarkdown", () => ({ default: ({ content }: { content: string }) => <div>{content}</div> }));
vi.mock("@/components/approval/AccessRequestModal", () => ({ default: () => null }));
let root: Root | undefined;
let container: HTMLDivElement | undefined;
afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = undefined;
  vi.unstubAllGlobals();
});

describe("局部修改确认详情", () => {
  it("展示真实差异和处数，全文删除仍展示删除内容", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      action: "update", targetWikiId: "doc", targetTitle: "排练记录", targetBody: "原文", body: "", title: null,
      patchDiff: "@@ -1 +0,0 @@\n-原文\n", patchCounts: [1], summary: "删除重复内容", hasPermission: true,
      permissionKey: "node:wiki/doc@edit", status: "pending",
    }))));
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root!.render(<WikiProposalPreviewModal open onClose={() => {}} productionId="p" toolCallId="call" />));
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain("共 1 处");
    expect(dialog.querySelector("pre")?.textContent).toContain("-原文");
    expect(dialog.textContent).not.toContain("正文不变");
  });
});
