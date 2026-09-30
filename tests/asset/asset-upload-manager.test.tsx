// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AssetUploadManagerProvider,
  useAssetUploadManager,
  type UploadTaskExecutor,
} from "@/components/assets/asset-upload-manager";

const refreshMock = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: refreshMock }) }));

const result = {
  assetId: "ast_765",
  fileId: "af_765",
  name: null,
  fileName: "凭证.pdf",
  assetType: "reference" as const,
  storageType: "r2" as const,
};

function Starter({ executor }: { executor: UploadTaskExecutor }) {
  const manager = useAssetUploadManager()!;
  return (
    <button type="button" onClick={() => manager.startTask({
      productionId: "prod_765",
      fileName: "凭证.pdf",
      target: { kind: "mount", mountType: "event", mountId: "evt_765", label: "演出" },
      executor,
    })}>开始</button>
  );
}

describe("全局上传任务", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    refreshMock.mockReset();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  async function render(executor: UploadTaskExecutor) {
    await act(async () => root.render(
      <AssetUploadManagerProvider><Starter executor={executor} /></AssetUploadManagerProvider>,
    ));
    await act(async () => {
      [...container.querySelectorAll("button")].find(button => button.textContent === "开始")!.click();
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  it("挂载失败保留已上传资产，重试只重做挂载", async () => {
    const executor = vi.fn(async () => result);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "挂载暂时失败" }), { status: 500 }))
      .mockResolvedValueOnce(new Response(null, { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);

    await render(executor);
    expect(container.textContent).toContain("挂载暂时失败");
    expect(executor).toHaveBeenCalledTimes(1);

    await act(async () => {
      [...container.querySelectorAll("button")].find(button => button.textContent === "重试")!.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(executor).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain("已完成");
    expect(refreshMock).toHaveBeenCalledTimes(1);
  });

  it("取消会中止执行器并保留可见的取消结果", async () => {
    const executor = vi.fn(({ signal }) => new Promise<typeof result>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new DOMException("cancelled", "AbortError")), { once: true });
    }));
    vi.stubGlobal("fetch", vi.fn());

    await render(executor);
    await act(async () => {
      [...container.querySelectorAll("button")].find(button => button.textContent === "取消")!.click();
      await Promise.resolve();
    });

    expect(container.textContent).toContain("已取消上传");
  });
});
