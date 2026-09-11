import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// 打印页只用 router 做「返回文档」，渲染断言里不需要真路由
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {} }) }));
// 正文渲染与本测试无关（shiki 懒加载会拖慢且不稳），替换成空实现
vi.mock("@/components/wiki/WikiMarkdown", () => ({ default: () => null }));

import WikiPrintPage from "@/components/wiki/WikiPrintPage";

/**
 * wiki 导出 PDF 无水印的回归护栏（#335）。
 *
 * 原来的漏洞不在「忘了加水印」，而在**加错了地方**：全页水印节点由脚本挂在
 * document.body 直下，而 globals.css 的
 *   body:has(.wiki-print-root) > *:not(.wiki-print-root) { display: none }
 * 在打印时会把它一起隐藏——屏幕上看得见水印，导出的 PDF 却是裸的。
 *
 * 所以这里断言的是「水印在打印树**内部**」，而不是「页面上有水印」。
 * 任何人把水印挪回外层 overlay，这两条都会红。
 */
function render(watermarkText: string | null): string {
  return renderToStaticMarkup(
    <WikiPrintPage
      productionId="p1"
      productionName="某演出"
      wikiId="w1"
      title="标题"
      body="正文"
      updatedAt="2026-08-26T00:00:00.000Z"
      watermarkText={watermarkText}
    />,
  );
}

describe("wiki 打印页水印", () => {
  it("水印节点在打印树内部，且带访问者身份", () => {
    const html = render("张三 zhangsan@example.com");
    const root = html.slice(html.indexOf("wiki-print-root"));
    expect(root).toContain("background-image");
    expect(root).toContain("background-repeat:repeat");
    // tile 是 SVG data URI，身份是 URL 编码后嵌在里面的
    expect(decodeURIComponent(root)).toContain("张三 zhangsan@example.com");
  });

  it("水印平铺在会跨页断开的那个盒子上——一条流也要页页有水印", () => {
    const html = render("张三 zhangsan@example.com");
    // 内容盒带背景，内边距在更内层：水印要盖到页边距区域，不能只有正文栏
    expect(html).toMatch(/background-image[^"]*data:image\/svg/);
  });

  it("watermarkText 为 null 时不画水印（不能退化成空 tile）", () => {
    const html = render(null);
    expect(html).not.toContain("background-image");
    expect(html).not.toContain("data:image/svg");
  });

  it("纸张尺寸由打印页自己声明——globals.css 已不再兜底 @page size", () => {
    expect(render(null)).toContain("@page { size: A4 portrait; margin: 0; }");
  });
});
