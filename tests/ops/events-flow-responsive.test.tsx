import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const component = readFileSync("components/ops/EventsClient.tsx", "utf8");
const css = readFileSync("components/ops/responsive.module.css", "utf8");

describe("事件页三步流程的窄屏布局", () => {
  it("将序号、标题和说明交给响应式样式控制", () => {
    expect(component).toContain("className={responsive.flowNumber}");
    expect(component).toContain("className={responsive.flowTitle}");
    expect(component).toContain("className={responsive.flowDescription}");
  });

  it("在 640px 以下仍保持横向三列并允许长说明换行", () => {
    expect(css).toContain(".flowExplainer { grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 6px; margin-bottom: 12px; }");
    expect(css).not.toContain(".flowExplainer { grid-template-columns: 1fr; }");
    expect(css).toContain(".flowDescription { margin-top: 2px; font-size: 10px; line-height: 1.35; }");
    expect(css).toContain("overflow-wrap: anywhere;");
  });

  it("窄屏卡片使用可收缩列和紧凑内边距", () => {
    expect(css).toContain("grid-template-columns: 22px minmax(0, 1fr)");
    expect(css).toContain("padding: 9px 7px");
    expect(css).toContain("font-size: clamp(10px, 3vw, 12px)");
  });
});
