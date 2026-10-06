import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("云文档与文内目录的响应式边界", () => {
  const shell = readFileSync("components/wiki/WikiShell.tsx", "utf8");
  const outline = readFileSync("components/wiki/WikiOutline.tsx", "utf8");
  const docPage = readFileSync("app/production/[id]/wiki/[wikiId]/page.tsx", "utf8");

  it("手机与平板提供两个独立语义入口", () => {
    expect(shell).toContain('<NavigationIcon name="knowledge" />');
    expect(shell).toContain("\n        云文档\n");
    expect(outline).toContain('<NavigationIcon name="outline" />');
    expect(outline).toContain("\n        目录\n");
  });

  it("两个抽屉都避开 AppShell 顶栏与底部导航", () => {
    expect(shell).toMatch(/panel-mobile-full fixed inset-x-0 z-\[45\]/);
    expect(shell).toMatch(/panel-mobile-full fixed left-0 z-\[46\]/);
    expect(outline).toMatch(/panel-mobile-full fixed inset-x-0 z-\[45\]/);
    expect(outline).toMatch(/panel-mobile-full fixed right-0 z-\[46\]/);
  });

  it("桌面展开宽度稳定，收起后只保留窄入口", () => {
    expect(shell).toContain("lg:w-[264px]");
    expect(shell).toContain("h-9 w-9 shrink-0");
    expect(outline).toContain("w-[208px] shrink-0");
    expect(outline).toContain("h-9 w-9 shrink-0");
    expect(docPage).toContain('padding: "16px clamp(12px, 1.8vw, 28px) 48px"');
    expect(docPage).not.toContain("clamp(18px, 3vw, 52px)");
  });
});
