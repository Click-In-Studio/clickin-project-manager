import { describe, it, expect } from "vitest";
import { PAGE_CONFIGS, printPageCss } from "@/lib/script-page";
import type { PageLayout } from "@/lib/script-types";

/**
 * 纸张尺寸回归护栏（#335）。
 *
 * 改动前 globals.css 硬编码 `@page { size: A4 portrait }`，而演出可选四种版式——
 * letter / 双排版式打出来纸张对不上，只能靠用户在打印对话框里手动改。
 * 这组断言钉死「每种版式各自出各自的纸张尺寸」，任何人把它退回单一常量都会红。
 */
describe("printPageCss", () => {
  const layouts = Object.keys(PAGE_CONFIGS) as PageLayout[];

  it("每种版式的纸张尺寸都取自它自己的页盒，不是写死的 A4", () => {
    for (const layout of layouts) {
      const cfg = PAGE_CONFIGS[layout];
      expect(printPageCss(cfg)).toBe(
        `@page { size: ${cfg.width}px ${cfg.height}px; margin: 0; }`,
      );
    }
  });

  it("letter 与 a4 的纸张尺寸不同——退回硬编码 A4 时这条会红", () => {
    expect(printPageCss(PAGE_CONFIGS.letter)).not.toBe(printPageCss(PAGE_CONFIGS.a4));
    // 96dpi 下的 A4 / Letter 实际像素，防止有人"顺手"把两者对齐成同一个值
    expect(printPageCss(PAGE_CONFIGS.a4)).toContain("794px 1123px");
    expect(printPageCss(PAGE_CONFIGS.letter)).toContain("816px 1056px");
  });

  it("页边距恒为 0：页边距由页盒自己带，不能交给 @page", () => {
    for (const layout of layouts) {
      expect(printPageCss(PAGE_CONFIGS[layout])).toContain("margin: 0");
    }
  });

  it("双排版式暂时与单排同尺寸——cols 还是死字段，实现双栏时这条必须一起改", () => {
    // 断言的是现状而非理想：cols 目前没有任何消费方，双排版式渲染的仍是单栏页盒。
    // 真做了双栏排版（#338/#343）之后纸张要变成 width × cols，届时这条会红，
    // 提醒改的人连 printPageCss 一起改，而不是只改渲染、留下纸张对不上。
    expect(PAGE_CONFIGS["a3-2col"].cols).toBe(2);
    expect(printPageCss(PAGE_CONFIGS["a3-2col"])).toBe(printPageCss(PAGE_CONFIGS.a4));
    expect(printPageCss(PAGE_CONFIGS["tablet-2col"])).toBe(printPageCss(PAGE_CONFIGS.letter));
  });
});
