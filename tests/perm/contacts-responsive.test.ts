import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const component = readFileSync("components/perm/ContactsClient.tsx", "utf8");
const css = readFileSync("components/perm/contacts.module.css", "utf8");

function blockAfter(source: string, marker: string): string {
  const markerStart = source.indexOf(marker);
  if (markerStart < 0) throw new Error(`找不到样式块：${marker}`);

  const markerBrace = marker.lastIndexOf("{");
  const openBrace = markerBrace >= 0
    ? markerStart + markerBrace
    : source.indexOf("{", markerStart + marker.length);
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

function columnsAt(width: number): string {
  const breakpoints = [
    { min: 0, source: css },
    { min: 480, source: blockAfter(css, "@media (min-width: 480px)") },
    { min: 640, source: blockAfter(css, "@media (min-width: 640px)") },
    { min: 768, source: blockAfter(css, "@media (min-width: 768px)") },
    { min: 900, source: blockAfter(css, "@media (min-width: 900px)") },
    { min: 1024, source: blockAfter(css, "@media (min-width: 1024px)") },
    { min: 1280, source: blockAfter(css, "@media (min-width: 1280px)") },
  ];
  const active = breakpoints.filter(({ min }) => min <= width).at(-1)!;
  return declarations(active.source, ".memberGrid")["grid-template-columns"];
}

describe("人员名册响应式卡片", () => {
  it("按验收视口从窄屏两列逐级增加列数", () => {
    expect([319, 360, 571, 768, 1118].map(columnsAt)).toEqual([
      "repeat(2, minmax(0, 1fr))",
      "repeat(2, minmax(0, 1fr))",
      "repeat(3, minmax(0, 1fr))",
      "repeat(5, minmax(0, 1fr))",
      "repeat(7, minmax(0, 1fr))",
    ]);
  });

  it("姓名始终单行完整显示，停用标记不覆盖姓名", () => {
    const name = declarations(css, ".memberName");
    const nameText = declarations(css, ".memberNameText,\n.statusBadge");

    expect(name).toMatchObject({
      display: "flex",
      "white-space": "nowrap",
      "font-size": "clamp(13px, 1.65vw, 17px)",
    });
    expect(name).not.toHaveProperty("overflow");
    expect(name).not.toHaveProperty("text-overflow");
    expect(nameText).toMatchObject({ "flex": "0 0 auto", "white-space": "nowrap" });
  });

  it("窄屏缩小头像与卡片间距，职位和标签可换行且同排卡片等高", () => {
    const narrow = blockAfter(css, "@media (max-width: 479px)");
    const grid = declarations(css, ".memberGrid");
    const card = declarations(css, ".memberCard");
    const badges = declarations(css, ".badgeRow");

    expect(declarations(narrow, ".avatar")).toMatchObject({ width: "42px", height: "42px" });
    expect(declarations(narrow, ".memberCard")).toMatchObject({ padding: "9px 6px", gap: "5px" });
    expect(grid["align-items"]).toBe("stretch");
    expect(card.height).toBe("100%");
    expect(badges["flex-wrap"]).toBe("wrap");
    expect(declarations(css, "\n.badge {")).toMatchObject({
      "max-width": "100%",
      "overflow-wrap": "anywhere",
      "white-space": "normal",
    });
  });

  it("邮箱不造成横向溢出，页面仍然只提供名册展示", () => {
    expect(declarations(css, ".email")).toMatchObject({
      "max-width": "100%",
      overflow: "hidden",
      "text-overflow": "ellipsis",
      "white-space": "nowrap",
    });
    expect(component).toContain("className={styles.memberGrid}");
    expect(component).not.toMatch(/<button|<input|<form|contentEditable/);
  });
});
