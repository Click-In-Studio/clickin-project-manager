// @vitest-environment jsdom
//
// #456 的病灶在客户端接线：模态没把目标资产传给面板，于是「上传新版本」走的是
// 创建端点。这里钉住分叉本身——带 targetAssetId 时注册必须打
// assets/<id>/files，且 presign 要带上 assetId（门按目标分叉）；不带时行为照旧。
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import AssetUploadPanel from "@/components/assets/AssetUploadPanel";

type Call = { url: string; body: Record<string, unknown> | null };

let calls: Call[];

function jsonRes(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status, headers: { "Content-Type": "application/json" },
  });
}

/** 直传那一步不真跑网络：立刻 load(200)。 */
class FakeXHR {
  status = 200;
  upload = { addEventListener: () => {} };
  private handlers: Record<string, () => void> = {};
  addEventListener(type: string, h: () => void) { this.handlers[type] = h; }
  open() {}
  setRequestHeader() {}
  send() { queueMicrotask(() => this.handlers.load?.()); }
}

describe("AssetUploadPanel 追加版本模式", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    calls = [];
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    vi.stubGlobal("XMLHttpRequest", FakeXHR);
    vi.stubGlobal("fetch", vi.fn(async (url: unknown, init?: RequestInit) => {
      const u = String(url);
      calls.push({ url: u, body: init?.body ? JSON.parse(String(init.body)) : null });
      if (u.includes("/presign")) {
        return jsonRes({
          uploadUrl: "https://r2.example/put", r2Key: "assets/af_new/v2.dwg",
          fileId: "af_new", contentType: "image/vnd.dwg",
        });
      }
      return jsonRes({
        asset: { id: "ast_1", name: null, fileName: "设计图 v2.dwg", assetType: "reference", storageType: "r2" },
        file: { id: "af_new" },
      }, 201);
    }));
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  async function uploadOnce(props: { targetAssetId?: string }) {
    const onUploaded = vi.fn();
    await act(async () => {
      root.render(
        <AssetUploadPanel productionId="prod_1" onUploaded={onUploaded} {...props} />,
      );
    });

    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(["bytes"], "设计图 v2.dwg", { type: "image/vnd.dwg" });
    Object.defineProperty(input, "files", { value: [file], configurable: true });
    await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); });

    const submit = [...container.querySelectorAll("button")]
      .find(b => /上传新版本|确认上传/.test(b.textContent ?? ""))!;
    await act(async () => { submit.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    // 直传的 load 回调 + 其后的注册 fetch 各让一轮
    await act(async () => { await new Promise(r => setTimeout(r, 0)); });

    return { onUploaded, submitLabel: submit.textContent };
  }

  it("带 targetAssetId：注册打 files 端点，presign 带 assetId，UI 收敛", async () => {
    const { onUploaded } = await uploadOnce({ targetAssetId: "ast_1" });

    const presign = calls.find(c => c.url.includes("/presign"))!;
    expect(presign.body?.assetId).toBe("ast_1");

    const register = calls.find(c => !c.url.includes("/presign"))!;
    expect(register.url).toContain("/assets/ast_1/files");
    expect(register.body?.storageType).toBe("r2");
    expect(register.body?.fileName).toBe("设计图 v2.dwg");
    // 资产级字段不随版本文件重设
    expect(register.body).not.toHaveProperty("assetType");
    expect(register.body).not.toHaveProperty("name");
    expect(onUploaded).toHaveBeenCalledWith(expect.objectContaining({ assetId: "ast_1" }));

    // 类型 / 显示名 / 飞书分支都不出现在追加版本的面板里
    expect(container.querySelector("select")).toBeNull();
    expect([...container.querySelectorAll("button")].some(b => b.textContent === "飞书链接")).toBe(false);
    expect(container.textContent).not.toContain("显示名称");
  });

  it("不带 targetAssetId：仍打创建端点，presign 不带 assetId（行为不变）", async () => {
    await uploadOnce({});

    const presign = calls.find(c => c.url.includes("/presign"))!;
    expect(presign.body).not.toHaveProperty("assetId");

    const register = calls.find(c => !c.url.includes("/presign"))!;
    expect(register.url).toMatch(/\/assets$/);
    expect(register.body?.assetType).toBe("reference");
    expect(container.querySelector("select")).not.toBeNull();
  });
});
