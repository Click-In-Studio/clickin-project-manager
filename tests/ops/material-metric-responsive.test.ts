import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const client = readFileSync("components/ops/materials/MaterialsClient.tsx", "utf8");
const financePage = readFileSync("app/production/[id]/finance/page.tsx", "utf8");
const css = readFileSync("components/ops/materials/materials.module.css", "utf8");

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
    expect(client).toContain("styles.metrics");
    expect(client).toContain("styles.metric");
    expect(financePage).not.toContain("responsive.materialMetric");
  });

  it("手机端指标卡收为两列，列表切换成完整卡片", () => {
    const mobile = blockAfter(css, "@media (max-width: 760px)");

    expect(declarations(mobile, ".metrics")).toMatchObject({
      "grid-template-columns": "repeat(2, 1fr)",
    });
    expect(declarations(mobile, ".table")).toMatchObject({ display: "none" });
    expect(declarations(mobile, ".mobileCards")).toMatchObject({ display: "grid" });
  });

  it("详情抽屉在手机上占满可用宽度，动作区改为三列分组而不挤成竖排", () => {
    const mobile = blockAfter(css, "@media (max-width: 760px)");
    expect(declarations(mobile, ".drawer")).toMatchObject({ width: "100%", top: "48px" });
    expect(declarations(css, ".drawerActions")).toMatchObject({
      flex: "none", display: "grid", "overflow-y": "auto",
    });
    expect(declarations(mobile, ".actionGrid")).toMatchObject({
      "grid-template-columns": "repeat(3, minmax(0, 1fr))",
    });
    expect(declarations(css, ".button, .primary, .danger")).toMatchObject({
      "white-space": "nowrap",
    });
  });

  it("二维码和条码直接显示为可点击下载的预览，手机端改为单列", () => {
    const mobile = blockAfter(css, "@media (max-width: 760px)");
    expect(client).toContain("styles.labelPreviewGrid");
    expect(client).toContain("type=qr&format=svg&size=medium");
    expect(client).toContain("type=code128&format=svg&size=medium");
    expect(client).not.toContain(">下载 QR<");
    expect(declarations(mobile, ".labelPreviewGrid")).toMatchObject({
      "grid-template-columns": "1fr",
    });
  });
});
