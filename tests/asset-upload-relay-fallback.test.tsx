// @vitest-environment jsdom
//
// #457：小文件（<50MB）走单 presigned PUT，失败只 setError，没有任何降级——而
// multipart 分支有 direct→relay 的自适应兜底。R2 直连完全不通的网络（relay 当初
// 就是为这类环境做的）下，会出现「大文件传得上去、小文件一直失败」的荒谬局面。
//
// 这里钉住修复后的契约：
//   · 单 PUT 连续失败 SINGLE_PUT_ATTEMPTS 次后落到 multipart+relay，最终注册成功
//   · 降级后注册打的是 r2-multipart 形态（复用现成的中继链路）
//   · 追加版本模式下中继请求必须带 assetId（门按目标分叉，服务端同批收敛）
//   · 直连正常时不降级——不给绝大多数用户加 create + complete 两次常态往返
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import AssetUploadPanel from "@/components/assets/AssetUploadPanel";

type Call = { url: string; body: Record<string, unknown> | null };
type XhrCall = { method: string; url: string };

let calls: Call[];
let xhrCalls: XhrCall[];
/** 直连（R2）是否通——false 模拟「路由器对 R2 直连完全不通」 */
let directWorks: boolean;

function jsonRes(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status, headers: { "Content-Type": "application/json" },
  });
}

/** 直连 PUT 按 directWorks 成/败；中继 POST 恒成功。 */
class FakeXHR {
  status = 0;
  private method = "";
  private url = "";
  private handlers: Record<string, () => void> = {};
  upload = { addEventListener: () => {} };
  addEventListener(type: string, h: () => void) { this.handlers[type] = h; }
  open(method: string, url: string) { this.method = method; this.url = url; }
  setRequestHeader() {}
  send() {
    xhrCalls.push({ method: this.method, url: this.url });
    const isRelay = this.url.includes("/relay-part");
    queueMicrotask(() => {
      if (isRelay || directWorks) { this.status = 200; this.handlers.load?.(); }
      else { this.status = 0; this.handlers.error?.(); }   // 直连不通＝连不上，不是 4xx
    });
  }
}

describe("AssetUploadPanel 小文件直传降级（#457）", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    calls = []; xhrCalls = []; directWorks = false;
    localStorage.clear();          // chunk size 学习值不跨用例串味
    vi.useFakeTimers();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    vi.stubGlobal("XMLHttpRequest", FakeXHR);
    vi.stubGlobal("fetch", vi.fn(async (url: unknown, init?: RequestInit) => {
      const u = String(url);
      calls.push({ url: u, body: init?.body ? JSON.parse(String(init.body)) : null });
      // 顺序要紧：presign-multipart / presign-part 都含 "/presign"
      if (u.includes("/presign-multipart"))
        return jsonRes({ uploadId: "up_1", r2Key: "assets/af_mp/v.dwg", fileId: "af_mp", parts: [] });
      if (u.includes("/presign-part"))
        return jsonRes({ uploadUrl: "https://r2.example/part" });
      if (u.includes("/presign"))
        return jsonRes({
          uploadUrl: "https://r2.example/put", r2Key: "assets/af_single/v.dwg",
          fileId: "af_single", contentType: "image/vnd.dwg",
        });
      return jsonRes({
        asset: { id: "ast_1", name: null, fileName: "设计图.dwg", assetType: "reference", storageType: "r2" },
        file: { id: "af_mp" },
      }, 201);
    }));
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  async function uploadOnce(props: { targetAssetId?: string } = {}) {
    const onUploaded = vi.fn();
    await act(async () => {
      root.render(<AssetUploadPanel productionId="prod_1" onUploaded={onUploaded} {...props} />);
    });

    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(["bytes"], "设计图.dwg", { type: "image/vnd.dwg" });
    Object.defineProperty(input, "files", { value: [file], configurable: true });
    await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); });

    const submit = [...container.querySelectorAll("button")]
      .find(b => /上传新版本|确认上传/.test(b.textContent ?? ""))!;
    await act(async () => { submit.dispatchEvent(new MouseEvent("click", { bubbles: true })); });

    // 重试/降级之间有 RETRY_DELAY_MS 的停顿：推假时钟直到落地
    await act(async () => {
      for (let i = 0; i < 12 && onUploaded.mock.calls.length === 0; i++)
        await vi.advanceTimersByTimeAsync(2000);
    });
    return { onUploaded };
  }

  it("直连不通：单 PUT 重试耗尽后降级到 multipart+relay，最终传成", async () => {
    const { onUploaded } = await uploadOnce();

    // 单 PUT 真的重试过（不是一击即溃），且都打在直连地址上
    const singlePuts = xhrCalls.filter(c => c.url === "https://r2.example/put");
    expect(singlePuts.length).toBeGreaterThan(1);
    expect(singlePuts.every(c => c.method === "PUT")).toBe(true);

    // 降级后确实走了中继
    const relay = xhrCalls.filter(c => c.url.includes("/relay-part"));
    expect(relay.length).toBe(1);
    expect(relay[0].method).toBe("POST");

    // 注册以 multipart 形态落地——复用的是现成的中继链路，不是另起一套
    const register = calls.find(c => c.body?.storageType === "r2-multipart");
    expect(register).toBeDefined();
    expect(register!.body?.uploadId).toBe("up_1");
    expect(register!.url).toMatch(/\/assets$/);
    expect(onUploaded).toHaveBeenCalledTimes(1);
  });

  it("追加版本模式下降级：中继请求带 assetId（门按目标分叉）", async () => {
    const { onUploaded } = await uploadOnce({ targetAssetId: "ast_1" });

    const relay = xhrCalls.find(c => c.url.includes("/relay-part"))!;
    expect(relay.url).toContain("assetId=ast_1");
    // presign-part 也一直带着（接线前后同源）
    expect(calls.find(c => c.url.includes("/presign-part"))!.url).toContain("assetId=ast_1");
    expect(calls.find(c => c.url.includes("/presign-multipart"))!.body?.assetId).toBe("ast_1");
    expect(onUploaded).toHaveBeenCalledWith(expect.objectContaining({ assetId: "ast_1" }));
  });

  it("直连正常：一次 PUT 就走完单传路径，不碰 multipart / relay", async () => {
    directWorks = true;
    const { onUploaded } = await uploadOnce();

    expect(xhrCalls).toEqual([{ method: "PUT", url: "https://r2.example/put" }]);
    expect(calls.some(c => c.url.includes("/presign-multipart"))).toBe(false);
    const register = calls.find(c => c.body?.storageType === "r2")!;
    expect(register.body?.fileId).toBe("af_single");
    expect(onUploaded).toHaveBeenCalledTimes(1);
  });
});
