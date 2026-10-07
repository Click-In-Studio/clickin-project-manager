import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const component = readFileSync("components/wiki/WikiDocClient.tsx", "utf8");
const css = readFileSync("components/wiki/WikiDocClient.module.css", "utf8");

function blockAfter(source: string, marker: string): string {
  const markerStart = source.indexOf(marker);
  if (markerStart < 0) throw new Error(`找不到样式块：${marker}`);
  const openBrace = source.indexOf("{", markerStart);
  if (openBrace < 0) throw new Error(`样式块缺少左花括号：${marker}`);

  let depth = 0;
  for (let index = openBrace; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
    if (depth === 0) return source.slice(openBrace + 1, index);
  }
  throw new Error(`样式块缺少右花括号：${marker}`);
}

describe("云文档头部与正文响应式布局", () => {
  it("标题和标签独占完整行，不再与右侧操作争抢宽度", () => {
    expect(component).toContain("<header className={styles.header}>");
    expect(component.indexOf("className={styles.toolbar}")).toBeLessThan(component.indexOf("className={styles.titleBlock}"));
    expect(component).toContain("className={`${styles.tagsInput}");
    expect(blockAfter(css, ".titleBlock,")).toMatch(/width:\s*100%;[\s\S]*min-width:\s*0;/);
    expect(css).toMatch(/\.titleInput,\s*\n\.tagsInput\s*\{\s*display:\s*block;/);
  });

  it("导出、编辑模式和分享集中在顶部操作栏，权限项不产生空占位", () => {
    const toolbarStart = component.indexOf('<div className={styles.toolbar} aria-label="文档操作栏">');
    const toolbarEnd = component.indexOf('<div className={styles.titleBlock}>');
    const toolbar = component.slice(toolbarStart, toolbarEnd);

    expect(toolbarStart).toBeGreaterThan(-1);
    expect(toolbar).toContain(">导出</button>");
    expect(toolbar).toContain("{canEdit && (");
    expect(toolbar).toContain("富文本");
    expect(toolbar).toContain("源码");
    expect(toolbar).toContain("{canShare && (");
    expect(toolbar).toContain(">分享</button>");
    expect(toolbar).not.toContain("visibility: hidden");
  });

  it("四个动作的可点击按钮统一为 36px 高、8px 外圆角", () => {
    const controls = blockAfter(css, ".actionButton,");
    expect(controls).toMatch(/height:\s*36px;/);
    expect(controls).toMatch(/min-height:\s*36px;/);
    expect(blockAfter(css, ".actionButton {")).toMatch(/border-radius:\s*8px;/);
    expect(blockAfter(css, ".modeButton:first-child")).toMatch(/border-radius:\s*8px 0 0 8px;/);
    expect(blockAfter(css, ".modeButton:last-child")).toMatch(/border-radius:\s*0 8px 8px 0;/);
  });

  it("386px、879px 与桌面宽度分别使用 16、24、32px 对称安全留白", () => {
    expect(blockAfter(css, ".document")).toContain("--wiki-doc-inline-padding: 32px");
    expect(blockAfter(css, "@media (max-width: 1023px)")).toContain("--wiki-doc-inline-padding: 24px");
    expect(blockAfter(css, "@media (max-width: 640px)")).toContain("--wiki-doc-inline-padding: 16px");

    for (const selector of [".canvas,", ".related"]) {
      const block = blockAfter(css, selector);
      expect(block).toContain("padding-right: var(--wiki-doc-inline-padding)");
      expect(block).toContain("padding-left: var(--wiki-doc-inline-padding)");
    }
    expect(blockAfter(css, ".header")).toContain("var(--wiki-doc-inline-padding)");

    const mobile = blockAfter(css, "@media (max-width: 640px)");
    expect(mobile).toMatch(/\.sourceEditor,[\s\S]*?\.canvas :global\(\.smart-textarea-blocktools\)[\s\S]*?padding-right:\s*0;[\s\S]*?padding-left:\s*0;/);
  });

  it("操作栏通过换行保持所有动作可达，不依赖会裁切按钮的横向滚动", () => {
    const toolbar = blockAfter(css, ".toolbar");
    expect(toolbar).toMatch(/width:\s*100%;/);
    expect(toolbar).toMatch(/flex-wrap:\s*wrap;/);
    expect(toolbar).toMatch(/justify-content:\s*flex-end;/);
    expect(toolbar).not.toMatch(/overflow(-x)?:/);
    expect(component).not.toContain("overflow-x-auto pb-1 sm:pb-0");
  });
});
