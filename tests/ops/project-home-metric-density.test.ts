import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workspaceHome = readFileSync("components/ops/HomeClient.tsx", "utf8");
const productionHome = readFileSync("components/ops/ProductionHomeClient.tsx", "utf8");
const css = readFileSync("components/ops/home.module.css", "utf8");

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

describe("项目首页指标卡密度与配色", () => {
  it("平台首页和项目首页共用同一组指标卡样式", () => {
    for (const component of [workspaceHome, productionHome]) {
      expect(component).toMatch(/styles from ["'][^"']*home\.module\.css["']/);
      expect(component).toContain("styles.progressHeroMetrics");
      expect(component).toContain("styles.progressMetricCard");
      expect(component).toContain("title={milestoneSubLabel}");
    }
  });

  it("卡面以高不透明度浅色为主，并用深色正文和清晰边框保持对比", () => {
    expect(declarations(css, ".progressMetricCard")).toMatchObject({
      "border": "1px solid rgba(255,255,255,.72)",
      "background": "rgba(250,252,251,.9)",
      "color": "#203b39",
    });
    expect(declarations(css, ".progressMetricCard span")).toMatchObject({
      "color": "#36534f",
      "white-space": "nowrap",
      "text-overflow": "ellipsis",
    });
    expect(declarations(css, ".progressMetricCard small")).toMatchObject({
      "color": "#526b67",
    });
  });

  it("手机宽度保留三列并收紧卡片内部密度", () => {
    const mobile = blockAfter(css, "@media (max-width: 680px)");

    expect(declarations(mobile, ".progressHeroMetrics")).toMatchObject({
      "grid-template-columns": "repeat(3, minmax(0, 1fr))",
      "gap": "6px",
    });
    expect(declarations(mobile, ".progressMetricCard")).toMatchObject({
      "min-height": "80px",
      "padding": "9px 8px",
    });
    expect(declarations(mobile, ".progressMetricCard span")).toMatchObject({
      "margin-top": "4px",
      "font-size": "clamp(8px, 2.8vw, 10px)",
    });
  });

  it("极窄屏继续释放水平空间，同时保持整卡点击高度", () => {
    const narrow = blockAfter(css, "@media (max-width: 360px)");

    expect(declarations(narrow, ".progressHero")).toMatchObject({ padding: "16px" });
    expect(declarations(narrow, ".progressMetricCard")).toMatchObject({
      "min-height": "76px",
      "padding": "8px 7px",
    });
  });
});
