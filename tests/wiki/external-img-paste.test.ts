// @vitest-environment jsdom
// 粘贴 HTML 的 img 收口（lib/external-img-paste）：外链图不许冒充嵌入——落库成
// ![](https://…) 会绕过边表/权限/URL 过期三重纪律。此前只堵了飞书一家。
import { describe, it, expect } from "vitest";
import { stripExternalPastedImages } from "@/lib/external-img-paste";
import { embedMediaKind, isEmbeddableUpload } from "@/lib/asset/embed-media";

describe("stripExternalPastedImages", () => {
  it("外链 img → 降级为链接文字（信息不丢）", () => {
    const out = stripExternalPastedImages(`<p>前<img src="https://evil.example/a.png" alt="示意图">后</p>`);
    expect(out).not.toContain("<img");
    expect(out).toContain(`<a href="https://evil.example/a.png">[图片：示意图]</a>`);
  });

  it("data: 内嵌图 → 占位文字（不落 base64 进正文）", () => {
    const out = stripExternalPastedImages(`<p><img src="data:image/png;base64,AAAA"></p>`);
    expect(out).not.toContain("<img");
    expect(out).not.toContain("base64");
    expect(out).toContain("[图片：未导入]");
  });

  it("私有形态放行：data-cm-src 与 /__cm__ src 原样保留", () => {
    const html = `<img data-cm-src="/__cm__/asset/ast_1" src="https://cdn.example/t.webp"><img src="/__cm__/asset/ast_2">`;
    expect(stripExternalPastedImages(html)).toBe(html);
  });

  it("本站 thumb 端点 URL 反解 assetId → 还原私有形态（只读面复制回贴）", () => {
    const out = stripExternalPastedImages(
      `<img src="/click-in/api/production/p1/assets/ast_x9/thumb?v=3" alt="剧照">`,
    );
    expect(out).toContain(`data-cm-src="/__cm__/asset/ast_x9"`);
    expect(out).toContain("<img");
  });

  it("无 img 的 HTML 原样返回（零成本快路径）", () => {
    const html = `<p>纯文字</p>`;
    expect(stripExternalPastedImages(html)).toBe(html);
  });
});

describe("embed-media broker", () => {
  it("image/video/audio 有嵌入形态；长尾（pdf 等）没有", () => {
    expect(embedMediaKind("image/png")).toBe("image");
    expect(embedMediaKind("video/mp4")).toBe("video");
    expect(embedMediaKind("audio/mpeg")).toBe("audio");
    expect(embedMediaKind("application/pdf")).toBeNull();
    expect(embedMediaKind(null)).toBeNull();
    expect(isEmbeddableUpload("audio/wav")).toBe(true);
    expect(isEmbeddableUpload("application/zip")).toBe(false);
  });
});
