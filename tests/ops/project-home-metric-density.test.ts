import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workspaceHome = readFileSync("components/ops/HomeClient.tsx", "utf8");
const productionHome = readFileSync("components/ops/ProductionHomeClient.tsx", "utf8");
const disclosure = readFileSync("components/ops/MetricCardDisclosure.tsx", "utf8");
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

type Rgba = [number, number, number, number];

function rgba(value: string): Rgba {
  const color = value.match(/rgba?\([^)]+\)|#[0-9a-f]{6}/i)?.[0];
  if (!color) throw new Error(`无法解析颜色：${value}`);
  if (color.startsWith("#")) {
    const hex = color.slice(1);
    return [0, 2, 4].map(index => Number.parseInt(hex.slice(index, index + 2), 16)).concat(1) as Rgba;
  }
  const parts = color.match(/[\d.]+/g)?.map(Number);
  if (!parts || parts.length < 3) throw new Error(`无法解析颜色：${value}`);
  return [parts[0], parts[1], parts[2], parts[3] ?? 1];
}

function composite(foreground: Rgba, background: Rgba): Rgba {
  const alpha = foreground[3] + background[3] * (1 - foreground[3]);
  return [0, 1, 2].map(index => (
    (foreground[index] * foreground[3] + background[index] * background[3] * (1 - foreground[3])) / alpha
  )).concat(alpha) as Rgba;
}

function luminance(color: Rgba): number {
  const channels = color.slice(0, 3).map(channel => {
    const normalized = channel / 255;
    return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrastRatio(foreground: string, background: Rgba): number {
  const foregroundLum = luminance(rgba(foreground));
  const backgroundLum = luminance(background);
  return (Math.max(foregroundLum, backgroundLum) + 0.05) / (Math.min(foregroundLum, backgroundLum) + 0.05);
}

function px(value: string): number {
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) throw new Error(`无法解析长度：${value}`);
  return parsed;
}

describe("项目首页指标卡密度与配色", () => {
  it("平台首页和项目首页共用同一组指标卡样式", () => {
    for (const component of [workspaceHome, productionHome]) {
      expect(component).toMatch(/styles from ["'][^"']*home\.module\.css["']/);
      expect(component).toContain("styles.progressHeroMetrics");
      expect(component).toContain("styles.progressMetricCard");
      expect(component).toContain("<MetricCardDisclosure label={milestoneSubLabel} />");
    }
    expect(disclosure).toContain('className={styles.progressMetricLabel}');
  });

  it("项目首页只保留指标本身，并维持通知与 Cue 的整卡跳转", () => {
    expect(productionHome).not.toContain("需要你的确认");
    expect(productionHome).not.toContain("有待处理风险");
    expect(productionHome).toContain("待处理通知");
    expect(productionHome).toContain("Cue 风险提示");
    expect(productionHome).toContain('href={`/production/${productionId}/notifications`}');
    expect(productionHome).toContain('href={`/production/${productionId}/cues`}');
    expect(productionHome).toContain("<MetricCardDisclosure label={milestoneSubLabel} />");
    expect(productionHome).toContain("<small>临近节点</small>");
  });

  it("三种卡面都以高不透明度浅色为主，并达到正文对比度基线", () => {
    const heroDarkEdge = rgba("#223e3d");
    const card = declarations(css, ".progressMetricCard");
    const label = declarations(css, ".progressMetricLabel");
    const small = declarations(css, ".progressMetricCard small");
    const variants = [
      { card, strong: card.color },
      { card: { ...card, ...declarations(css, ".progressMetricUrgent") }, strong: declarations(css, ".progressMetricUrgent strong").color },
      { card: { ...card, ...declarations(css, ".progressMetricWarn") }, strong: declarations(css, ".progressMetricWarn strong").color },
    ];

    for (const variant of variants) {
      const surfaceColor = rgba(variant.card.background);
      const surface = composite(surfaceColor, heroDarkEdge);
      expect(surfaceColor[3]).toBeGreaterThanOrEqual(0.9);
      expect(rgba(variant.card["border-color"] ?? variant.card.border)[3]).toBeGreaterThanOrEqual(0.65);
      expect(contrastRatio(variant.strong, surface)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(label.color, surface)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(small.color, surface)).toBeGreaterThanOrEqual(4.5);
    }

    expect(label).toMatchObject({
      "white-space": "nowrap",
      "text-overflow": "ellipsis",
    });
  });

  it("手机宽度保留三列并收紧卡片内部密度", () => {
    const desktopGrid = declarations(css, ".progressHeroMetrics");
    const desktopCard = declarations(css, ".progressMetricCard");
    const desktopStrong = declarations(css, ".progressMetricCard strong");
    const mobile = blockAfter(css, "@media (max-width: 680px)");

    const grid = declarations(mobile, ".progressHeroMetrics");
    const card = declarations(mobile, ".progressMetricCard");
    const label = declarations(mobile, ".progressMetricLabel");

    expect(desktopGrid["grid-template-columns"]).toBe("repeat(3, minmax(0, 1fr))");
    expect(desktopGrid["align-items"]).toBe("stretch");
    expect(desktopCard.height).toBeUndefined();
    expect(desktopCard["min-height"]).toContain("clamp(");
    expect(desktopCard.padding).toContain("clamp(");
    expect(desktopStrong["font-size"]).toContain("clamp(");
    expect(grid["grid-template-columns"]).toBe("repeat(3, minmax(0, 1fr))");
    expect(px(grid.gap)).toBeLessThanOrEqual(6);
    expect(px(card["min-height"])).toBeGreaterThanOrEqual(44);
    expect(px(card["min-height"])).toBeLessThanOrEqual(80);
    expect(card.padding.split(" ").map(px).every(value => value <= 9)).toBe(true);
    expect(label["font-size"]).toContain("clamp(");
  });

  it("319 与 360 像素下同步收紧容器、卡片和字号，并保持整卡点击", () => {
    const narrow = blockAfter(css, "@media (max-width: 360px)");

    const hero = declarations(narrow, ".progressHero");
    const grid = declarations(narrow, ".progressHeroMetrics");
    const card = declarations(narrow, ".progressMetricCard");
    const strong = declarations(narrow, ".progressMetricCard strong");
    const label = declarations(narrow, ".progressMetricLabel");

    expect(px(hero.padding)).toBeLessThanOrEqual(14);
    expect(px(hero["border-radius"])).toBeLessThanOrEqual(12);
    expect(px(grid.gap)).toBeLessThanOrEqual(4);
    expect(px(card["min-height"])).toBeGreaterThanOrEqual(44);
    expect(card.padding.split(" ").map(px).every(value => value <= 7)).toBe(true);
    expect(px(card["border-radius"])).toBeLessThanOrEqual(8);
    expect(strong["font-size"]).toContain("clamp(");
    expect(label["font-size"]).toContain("clamp(");
    expect(css).toContain("button.progressMetricLabel::before");
    expect(declarations(css, "button.progressMetricLabel::before").inset).toBe("0");
    expect(declarations(css, ".progressMetricDisclosure").position).toBe("static");
  });

  it("571 与 1118 像素下卡片依内容伸展而不是固定高度", () => {
    const desktopCard = declarations(css, ".progressMetricCard");
    const mobileCard = declarations(blockAfter(css, "@media (max-width: 680px)"), ".progressMetricCard");

    expect(desktopCard.height).toBeUndefined();
    expect(mobileCard.height).toBeUndefined();
    expect(desktopCard["justify-content"]).toBe("center");
    expect(px(mobileCard["min-height"])).toBeLessThan(92);
  });
});
