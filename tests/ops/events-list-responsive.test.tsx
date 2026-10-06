// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import EventsClient from "@/components/ops/EventsClient";
import type { ProductionEvent } from "@/lib/ops/event-db";

vi.mock("next/link", () => ({
  default: ({ children, href, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) => (
    <a href={href} {...props}>{children}</a>
  ),
}));

const css = readFileSync("components/ops/responsive.module.css", "utf8");
const component = readFileSync("components/ops/EventsClient.tsx", "utf8");

function blockAfter(source: string, marker: string): string {
  const markerStart = source.indexOf(marker);
  if (markerStart < 0) throw new Error(`找不到样式块：${marker}`);
  const braceInMarker = marker.lastIndexOf("{");
  const openBrace = braceInMarker >= 0
    ? markerStart + braceInMarker
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

function event(overrides: Partial<ProductionEvent> & Pick<ProductionEvent, "id" | "title">): ProductionEvent {
  return {
    productionId: "responsive-events",
    eventType: "rehearsal",
    location: "排练厅",
    startTime: "2999-10-18T11:00:00.000Z",
    endTime: "2999-10-18T13:00:00.000Z",
    status: "published",
    description: "",
    stageManagers: [],
    chatId: null,
    versionId: null,
    createdBy: "creator",
    createdAt: "2026-09-30T00:00:00.000Z",
    updatedAt: "2026-09-30T00:00:00.000Z",
    ...overrides,
  };
}

describe("事件列表信息层级与响应式布局", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("覆盖即将发生/已过去、参与/关注、零任务/有任务", async () => {
    const upcoming = event({ id: "upcoming", title: "即将联排" });
    const past = event({
      id: "past",
      title: "已完成演出",
      eventType: "performance",
      startTime: "2000-01-02T11:00:00.000Z",
      endTime: "2000-01-02T13:00:00.000Z",
      status: "completed",
    });

    await act(async () => {
      root.render(
        <EventsClient
          productionId="responsive-events"
          initialEvents={[past, upcoming]}
          canCreate
          canViewFull
          myParticipations={[
            { eventId: upcoming.id, role: "participant" },
            { eventId: past.id, role: "follower" },
          ]}
          currentUserId="viewer"
          departments={[]}
          taskCounts={{ [past.id]: 3 }}
        />,
      );
    });

    const upcomingCard = container.querySelector<HTMLElement>('[aria-label="查看事件：即将联排"]')!;
    const pastCard = container.querySelector<HTMLElement>('[aria-label="查看事件：已完成演出"]')!;
    expect(upcomingCard.closest("section")?.textContent).toContain("即将发生");
    expect(pastCard.closest("section")?.textContent).toContain("已过去");
    expect(upcomingCard.textContent).toContain("已参与");
    expect(upcomingCard.textContent).not.toContain("个任务");
    expect(pastCard.textContent).toContain("已关注");
    expect(pastCard.textContent).toContain("3 个任务");
    expect(upcomingCard.querySelector("time")?.nextElementSibling?.textContent).toBe("排练");
    expect(pastCard.querySelector("time")?.nextElementSibling?.textContent).toBe("演出");
  });

  it("跨 UTC/CST 日期边界时日期盒与时间文案保持同一天", async () => {
    const previousTimezone = process.env.TZ;
    process.env.TZ = "UTC";
    try {
      const boundary = event({
        id: "cst-boundary",
        title: "跨日排练",
        startTime: "2026-09-10T16:30:00.000Z",
        endTime: "2026-09-10T18:30:00.000Z",
      });
      expect(new Date(boundary.startTime!).getDate()).toBe(10);

      await act(async () => {
        root.render(
          <EventsClient
            productionId="responsive-events"
            initialEvents={[boundary]}
            canCreate
            canViewFull
            myParticipations={[]}
            currentUserId="viewer"
            departments={[]}
            taskCounts={{}}
          />,
        );
      });

      const card = container.querySelector<HTMLElement>('[aria-label="查看事件：跨日排练"]')!;
      expect(card.querySelector("time b")?.textContent).toBe("11");
      expect(card.querySelector("time small")?.textContent).toContain("9 月");
      expect(card.textContent).toContain("9月11日 00:30");
    } finally {
      if (previousTimezone === undefined) delete process.env.TZ;
      else process.env.TZ = previousTimezone;
    }
  });

  it("桌面端保持日期、内容、状态三列，右列内容居中", () => {
    expect(declarations(css, ".eventCard")).toMatchObject({
      display: "grid",
      "grid-template-columns": "58px minmax(0, 1fr) auto",
      "column-gap": "16px",
    });
    expect(declarations(css, ".eventStatusColumn")).toMatchObject({
      "align-items": "center",
      "text-align": "center",
    });
  });

  it("分组滚动条贴近右边框，正文用滚动容器内间距避让", () => {
    expect(component).toContain("className={responsive.eventGroupHeader}");
    expect(component).toContain("responsive.eventGroupScroll} panel-scrollbar panel-scrollbar-area");
    expect(component).not.toContain('style={{ flex: 1, minHeight: 0, overflowY: "auto" }}');
    expect(declarations(css, ".eventGroup {")).toMatchObject({ padding: "22px 4px 22px 22px" });
    expect(declarations(css, ".eventGroupHeader")).toMatchObject({ "padding-right": "18px" });
    expect(declarations(css, ".eventGroupScroll")).toMatchObject({
      "padding-right": "14px",
      "overflow-y": "auto",
      "overscroll-behavior": "contain",
      "scrollbar-gutter": "stable",
    });
  });

  it("约 768–900px 时分组随内容收缩，仅在事件较多时内部滚动", () => {
    const tablet = blockAfter(css, "@media (max-width: 980px)");
    expect(declarations(tablet, ".eventGroup {")).toMatchObject({ height: "auto", "min-height": "0" });
    expect(declarations(tablet, ".eventGroupScroll")).toMatchObject({
      flex: "none",
      "max-height": "min(56vh, 460px)",
    });
  });

  it("386px 手机宽度保持紧凑密度、短信息操作间距和可点击区域", () => {
    const mobile = blockAfter(css, "@media (max-width: 640px)");
    expect(declarations(mobile, ".eventPage")).toMatchObject({
      "padding-bottom": "calc(60px + env(safe-area-inset-bottom))",
    });
    expect(declarations(mobile, ".eventGroup {")).toMatchObject({ padding: "16px 3px 16px 16px" });
    expect(declarations(mobile, ".eventGroupScroll")).toMatchObject({
      "max-height": "min(52vh, 420px)",
      "padding-right": "9px",
    });
    expect(declarations(mobile, ".eventCardActions")).toMatchObject({
      "grid-column": "2 / 4",
      "margin-top": "6px",
      "flex-wrap": "nowrap",
    });
    expect(declarations(mobile, ".eventCardActionButton")).toMatchObject({ "min-height": "32px" });
  });

  it("319px 下收紧日期字号、外框和容器内边距", () => {
    const narrow = blockAfter(css, "@media (max-width: 320px)");
    expect(declarations(narrow, ".eventPage")).toMatchObject({ padding: "24px 10px 60px" });
    expect(declarations(narrow, ".eventGroup {")).toMatchObject({ padding: "14px 3px 14px 14px" });
    expect(declarations(narrow, ".eventGroupScroll")).toMatchObject({ "padding-right": "7px" });
    expect(declarations(narrow, ".eventCard")).toMatchObject({
      "grid-template-columns": "48px minmax(0, 1fr) minmax(52px, auto)",
      "column-gap": "8px",
      padding: "14px 4px",
    });
    expect(declarations(narrow, ".eventDateBox")).toMatchObject({ width: "46px", height: "51px" });
    expect(declarations(narrow, ".eventDateDay")).toMatchObject({ "font-size": "19px" });
    expect(declarations(narrow, ".eventDateMonth")).toMatchObject({ "font-size": "8px" });
  });
});
