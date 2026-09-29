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

describe("事件卡片操作区的响应式布局", () => {
  it("用专用样式类控制操作区、按钮和箭头", () => {
    expect(component).toContain("className={responsive.eventCardActions}");
    expect(component.match(/className=\{responsive\.eventCardActionButton\}/g)).toHaveLength(3);
    expect(component.match(/className=\{responsive\.eventCardActionArrow\}/g)).toHaveLength(3);
    expect(component).not.toContain("INLINE_ACTION_BTN");
    expect(component).not.toContain("<span style={{ marginLeft: 3 }}>→</span>");
  });

  it("桌面端保留原有按钮尺寸与可换行行为", () => {
    expect(declarations(css, ".eventCardActions")).toMatchObject({
      "grid-column": "2",
      gap: "8px",
      "margin-top": "10px",
      "flex-wrap": "wrap",
    });
    expect(declarations(css, ".eventCardActionButton")).toMatchObject({
      "min-height": "28px",
      padding: "5px 8px",
      "font-size": "9px",
      "white-space": "nowrap",
    });
    expect(declarations(css, ".eventCardActionArrow")).toMatchObject({ "margin-left": "3px" });
  });

  it("手机端从内容列延伸到状态列，不侵入日期列", () => {
    const mobile = blockAfter(css, "@media (max-width: 640px)");
    expect(declarations(mobile, ".eventCardActions")).toMatchObject({
      "grid-column": "2 / 4",
      gap: "4px",
      "flex-wrap": "nowrap",
    });
    expect(declarations(mobile, ".eventCardActionButton")).toMatchObject({ "padding-inline": "5px" });
    expect(declarations(mobile, ".eventCardActionArrow")).toMatchObject({
      "margin-left": "1px",
      "font-size": ".85em",
    });
    expect(declarations(mobile, ".eventCardActionButton")["font-size"]).toBeUndefined();
  });

  it("360px 以下才进一步压缩间距、内边距与字号", () => {
    const narrow = blockAfter(css, "@media (max-width: 360px)");
    expect(declarations(narrow, ".eventCardActions")).toMatchObject({ gap: "2px" });
    expect(declarations(narrow, ".eventCardActionButton")).toMatchObject({
      "padding-inline": "3px",
      "font-size": "8.5px",
    });
  });
});
