// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { runAssetFileUpload } from "@/lib/asset/upload-client";

describe("multipart 上传取消", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it("中止正在传输的请求并通知服务端丢弃已上传分片", async () => {
    const controller = new AbortController();
    class HangingXHR {
      status = 0;
      upload = { addEventListener: () => {} };
      addEventListener() {}
      open() {}
      setRequestHeader() {}
      send() { queueMicrotask(() => controller.abort()); }
      abort() {}
    }
    vi.stubGlobal("XMLHttpRequest", HangingXHR);

    const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
      const path = String(url);
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      if (path.includes("/presign-multipart")) return new Response(JSON.stringify({
        uploadId: "up_765", r2Key: "assets/af_765/file.mov", fileId: "af_765", abortToken: "abort_765",
      }), { status: 200, headers: { "Content-Type": "application/json" } });
      if (path.includes("/presign-part")) return new Response(JSON.stringify({ uploadUrl: "https://r2.example/part" }), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
      throw new Error(`unexpected fetch ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const file = {
      name: "file.mov",
      type: "video/quicktime",
      size: 51 * 1024 * 1024,
      slice: () => new Blob(["part"]),
    } as File;

    await expect(runAssetFileUpload({
      productionId: "prod_765",
      file,
      assetType: "reference",
      name: null,
      placementFields: {},
    }, {
      signal: controller.signal,
      setProgress: () => {},
      setTransferMode: () => {},
      setProcessing: () => {},
    })).rejects.toMatchObject({ name: "AbortError" });

    const rollback = fetchMock.mock.calls.find(([, init]) => init?.method === "DELETE");
    expect(rollback).toBeDefined();
    expect(JSON.parse(String(rollback![1]?.body))).toEqual({
      r2Key: "assets/af_765/file.mov",
      uploadId: "up_765",
      abortToken: "abort_765",
    });
  });
});
