/**
 * useFontsSettled（#336 B3）的行为守卫。
 *
 * 钉的是它存在的理由：`document.fonts.ready` 在测量层挂上去之前就可能解析过了，
 * 之后的字体加载不会再有信号。所以 hook 必须
 *   · 挂载时按 `fonts.status` 给初值（loading → 未就位）
 *   · 每次 loadingdone 都调 onSettled（调用方拿它重测），并按 status 更新就位
 *   · 再次 loading 时回到未就位（就绪信号随之撤下）
 *   · 没有 FontFaceSet 的环境视为恒就位
 * jsdom 没有 document.fonts，用一个最小的假 FontFaceSet（EventTarget + status + ready）驱动。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useFontsSettled } from "@/components/print/use-fonts-settled";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class FakeFontFaceSet extends EventTarget {
  status: "loading" | "loaded" = "loaded";
  readyResolve: () => void = () => {};
  ready: Promise<FakeFontFaceSet>;
  constructor(status: "loading" | "loaded") {
    super();
    this.status = status;
    this.ready = new Promise((resolve) => { this.readyResolve = () => resolve(this); });
  }
  /** 模拟一批字体加载完成 */
  finish() {
    this.status = "loaded";
    this.dispatchEvent(new Event("loadingdone"));
    this.readyResolve();
  }
  /** 模拟新一批字体开始加载（重测引出的新字） */
  start() {
    this.status = "loading";
    this.dispatchEvent(new Event("loading"));
  }
}

function installFonts(fonts: FakeFontFaceSet | undefined) {
  Object.defineProperty(document, "fonts", { value: fonts, configurable: true });
}

let root: Root;
let container: HTMLDivElement;
let settledLog: boolean[];
let settledCalls: number;

function Probe() {
  const settled = useFontsSettled(() => { settledCalls += 1; });
  settledLog.push(settled);
  return <span data-settled={String(settled)} />;
}

function current(): string | null {
  return container.querySelector("span")?.getAttribute("data-settled") ?? null;
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  settledLog = [];
  settledCalls = 0;
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  installFonts(undefined);
});

describe("useFontsSettled", () => {
  it("没有 FontFaceSet（jsdom 原生）→ 恒就位", () => {
    installFonts(undefined);
    act(() => root.render(<Probe />));
    expect(current()).toBe("true");
  });

  it("挂载时字体还在加载 → 未就位；loadingdone 后就位并触发一次重测", async () => {
    const fonts = new FakeFontFaceSet("loading");
    installFonts(fonts);
    act(() => root.render(<Probe />));
    expect(current()).toBe("false");
    expect(settledCalls).toBe(0);

    await act(async () => { fonts.finish(); });
    expect(current()).toBe("true");
    // loadingdone 事件 + ready 解析各补一次，都算「字体到位了，重测」——多测一次无害，
    // 漏测一次就是回退字体的分页
    expect(settledCalls).toBeGreaterThanOrEqual(1);
  });

  it("挂载后才开始的加载也能收到：loading → 未就位，loadingdone → 就位 + 重测", async () => {
    const fonts = new FakeFontFaceSet("loaded");
    installFonts(fonts);
    act(() => root.render(<Probe />));
    expect(current()).toBe("true");
    const before = settledCalls;

    await act(async () => { fonts.start(); });
    expect(current()).toBe("false");

    await act(async () => { fonts.finish(); });
    expect(current()).toBe("true");
    expect(settledCalls).toBe(before + 1);
  });

  it("卸载后不再监听（事件不再触发回调）", async () => {
    const fonts = new FakeFontFaceSet("loaded");
    installFonts(fonts);
    act(() => root.render(<Probe />));
    act(() => root.unmount());
    root = createRoot(container); // afterEach 会再 unmount 一次
    const before = settledCalls;
    await act(async () => { fonts.start(); fonts.finish(); });
    expect(settledCalls).toBe(before);
  });
});
