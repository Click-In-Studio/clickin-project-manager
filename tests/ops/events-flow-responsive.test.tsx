import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const component = readFileSync("components/ops/EventsClient.tsx", "utf8");
const css = readFileSync("components/ops/responsive.module.css", "utf8");

function blockAfter(source: string, marker: string): string {
  const markerStart = source.indexOf(marker);
  if (markerStart < 0) throw new Error(`找不到样式块：${marker}`);

  const openBrace = source.indexOf("{", markerStart + marker.length);
  if (openBrace < 0) throw new Error(`样式块缺少左花括号：${marker}`);

  let depth = 0;
  for (let index = openBrace; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
    if (depth === 0) return source.slice(openBrace + 1, index);
  }
  throw new Error(`样式块缺少右花括号：${marker}`);
}

function declarations(source: string, selector: string): Record<string, string> {
  return Object.fromEntries(
    blockAfter(source, selector)
      .split(";")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const colon = line.indexOf(":");
        if (colon < 0) throw new Error(`无法解析样式声明：${line}`);
        return [line.slice(0, colon).trim(), line.slice(colon + 1).trim()];
      }),
  );
}

describe("事件页三步流程的窄屏布局", () => {
  it("将序号、标题和说明交给响应式样式控制", () => {
    expect(component).toContain("className={responsive.flowNumber}");
    expect(component).toContain("className={responsive.flowTitle}");
    expect(component).toContain("className={responsive.flowDescription}");
  });

  it("桌面端保留三卡加箭头的宽屏结构", () => {
    expect(declarations(css, ".flowExplainer")).toMatchObject({
      "grid-template-columns": "1fr auto 1fr auto 1fr",
      gap: "13px",
    });
    expect(declarations(css, ".flowCard")).toMatchObject({
      "min-width": "0",
      "min-height": "92px",
    });
  });

  it("在 980px 以下收起箭头并保持横向三列", () => {
    const tablet = blockAfter(css, "@media (max-width: 980px)");
    expect(declarations(tablet, ".flowExplainer")).toMatchObject({
      "grid-template-columns": "repeat(3, minmax(0, 1fr))",
      gap: "8px",
    });
    expect(declarations(tablet, ".flowArrow")).toMatchObject({ display: "none" });
    expect(declarations(tablet, ".flowTitle")).toMatchObject({ "font-size": "12px" });
  });

  it("在 640px 以下使用可收缩三列、紧凑尺寸和可换行说明", () => {
    const mobile = blockAfter(css, "@media (max-width: 640px)");
    expect(declarations(mobile, ".flowExplainer")).toMatchObject({
      "grid-template-columns": "repeat(3, minmax(0, 1fr))",
      gap: "6px",
      "margin-bottom": "12px",
    });
    expect(declarations(mobile, ".flowCard")).toMatchObject({
      "min-height": "78px",
      padding: "9px 7px",
      "grid-template-columns": "22px minmax(0, 1fr)",
    });
    expect(declarations(mobile, ".flowNumber")).toMatchObject({ width: "22px", height: "22px" });
    expect(declarations(mobile, ".flowTitle")).toMatchObject({ "font-size": "clamp(10px, 3vw, 12px)" });
    expect(declarations(css, ".flowDescription")).toMatchObject({
      "min-width": "0",
      "overflow-wrap": "anywhere",
    });
    expect(declarations(mobile, ".flowDescription")).toMatchObject({
      "font-size": "10px",
      "line-height": "1.35",
    });
  });
});
