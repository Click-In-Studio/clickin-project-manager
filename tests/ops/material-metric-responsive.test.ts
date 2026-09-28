import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const page = readFileSync("app/production/[id]/materials/page.tsx", "utf8");
const financePage = readFileSync("app/production/[id]/finance/page.tsx", "utf8");
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
      .map(line => line.trim())
      .filter(Boolean)
      .map(line => {
        const colon = line.indexOf(":");
        if (colon < 0) throw new Error(`无法解析样式声明：${line}`);
        return [line.slice(0, colon).trim(), line.slice(colon + 1).trim()];
      }),
  );
}

describe("物料统计卡移动端密度", () => {
  it("只给物料页叠加专用样式，不改变财务页的共享指标卡", () => {
    expect(page).toContain("responsive.materialMetricGrid");
    expect(page).toContain("responsive.materialMetricCard");
    expect(page).toContain("responsive.materialMetricValue");
    expect(page).toContain("responsive.materialMetricLabel");
    expect(financePage).not.toContain("responsive.materialMetric");
  });

  it("手机端固定为可收缩的三列，并压缩卡片间距和高度", () => {
    const mobile = blockAfter(css, "@media (max-width: 640px)");

    expect(declarations(mobile, ".materialMetricGrid")).toMatchObject({
      "grid-template-columns": "repeat(3, minmax(0, 1fr))",
      gap: "6px",
    });
    expect(declarations(mobile, ".materialMetricCard")).toMatchObject({
      "min-height": "54px",
      padding: "8px 7px",
      "border-radius": "10px",
    });
  });

  it("手机端突出数字，同时让较长状态标签安全换行", () => {
    const mobile = blockAfter(css, "@media (max-width: 640px)");

    expect(declarations(mobile, ".materialMetricValue")).toMatchObject({
      "font-size": "clamp(23px, 7vw, 27px)",
      "line-height": "1",
    });
    expect(declarations(mobile, ".materialMetricLabel")).toMatchObject({
      "font-size": "clamp(9px, 2.8vw, 10px)",
      "overflow-wrap": "anywhere",
    });
  });
});
