// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AttachmentMedia } from "@/components/agent/AttachmentMedia";

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
const attachment = { id: "aat_output", fileName: "片段.flac", mimeType: "audio/flac", status: "ready" };
async function show(overrides = {}) {
  await act(async () => root.render(<AttachmentMedia attachment={{ ...attachment, ...overrides }} sessionKey="session:one" onPreview={() => {}} />));
}

describe("附件内联展示与下载独立", () => {
  it("音频有鉴权播放器与独立下载，播放失败仍可下载", async () => {
    await show();
    expect(host.querySelector("audio")?.getAttribute("preload")).toBe("metadata");
    expect(host.querySelector("source")?.getAttribute("src")).toContain("sessionKey=session%3Aone");
    await act(async () => host.querySelector("source")!.dispatchEvent(new Event("error")));
    expect(host.textContent).toContain("当前浏览器无法预览");
    expect(host.querySelector("audio")).toBeNull();
    expect(host.querySelector("a")?.getAttribute("href")).toContain("&download=1");
  });

  it("TIFF 无内联预览仍显示下载；PNG 可预览", async () => {
    await show({ mimeType: "image/tiff", fileName: "拼图.tiff" });
    expect(host.querySelector("img")).toBeNull(); expect(host.querySelector("a")).not.toBeNull();
    await show({ mimeType: "image/png", fileName: "拼图.png" });
    expect(host.querySelector("img")).not.toBeNull();
  });

  it.each(["released", "expired", "deleting", "promoted", "pending"])("%s 不留下播放器或下载入口", async (status) => {
    await show({ status }); expect(host.querySelector("audio, img, a")).toBeNull();
  });
});
