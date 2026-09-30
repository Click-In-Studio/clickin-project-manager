import { describe, expect, it } from "vitest";
import { attachmentContentDisposition } from "@/lib/asset/content-disposition";
import { presignedGet } from "@/lib/r2";

describe("资产下载文件名（#799）", () => {
  it("中文名称用 filename* 传递，filename 只保留安全的 ASCII fallback", () => {
    const disposition = attachmentContentDisposition("舞台 图纸(终稿).pdf");

    expect(disposition).toBe(
      "attachment; filename=\"__ __(__).pdf\"; filename*=UTF-8''%E8%88%9E%E5%8F%B0%20%E5%9B%BE%E7%BA%B8%28%E7%BB%88%E7%A8%BF%29.pdf",
    );
  });

  it("路径分隔符、控制字符和引号不能进入 fallback 文件名", () => {
    const disposition = attachmentContentDisposition("../目录\\恶意\r\n\"文件\".txt");
    const fallback = disposition.match(/filename="([^"]*)"/)?.[1];

    expect(disposition).not.toMatch(/[\r\n]/);
    expect(fallback).toMatch(/^[\x20-\x7e]+$/);
    expect(fallback).not.toMatch(/["/\\%]/);
    expect(disposition).not.toContain("../");
  });

  it("预签名 GET 把下载文件名写入签名查询串，不再回退到 R2 key", () => {
    const contentDisposition = attachmentContentDisposition("中文文件.pdf");
    const url = presignedGet("assets/af_test/____.pdf", 3600, { contentDisposition });
    const parsed = new URL(url);
    const query = url.split("?")[1];

    expect(parsed.searchParams.get("response-content-disposition")).toBe(contentDisposition);
    // filename* 自身的 %E4... 在查询串里必须恰好编码一层为 %25E4...；
    // R2 解查询参数后才会把原始 %E4... 放进 Content-Disposition。
    expect(query).toContain("filename%2A%3DUTF-8%27%27%25E4%25B8%25AD");
    expect(query).not.toContain("%2525E4");
    expect(query).not.toContain("+");
  });
});
