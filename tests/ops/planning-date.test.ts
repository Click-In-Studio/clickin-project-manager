import { describe, it, expect } from "vitest";
import {
  ymd, hhmm, DAY_MS, floorToMonday, cstAxisDateFromIso, dateOnlyAxisMs, addDaysIso,
  minutesOfIso, fmtMin, withTime,
} from "@/components/ops/planning/date";

/**
 * 计划面板的日期纯函数（#487 P1 从 PlanningClient.tsx 搬出）。这批函数的共同口径是
 * 「一律 CST、只读 UTC 部件」——浏览器时区不同不能改变日历分桶 / 甘特分桶。用一个跨
 * CST 午夜的时刻做证人：UTC 2026-03-01T17:30Z = CST 2026-03-02 01:30。
 */
const CROSS = "2026-03-01T17:30:00.000Z";

describe("ymd / hhmm", () => {
  it("日历格子 Date 读 UTC 部件，不再 +8", () => {
    expect(ymd(new Date(Date.UTC(2026, 2, 2)))).toBe("2026-03-02");
    expect(ymd(new Date(Date.UTC(2026, 0, 1)))).toBe("2026-01-01");
  });
  it("hhmm 是 CST 的时分", () => {
    expect(hhmm(CROSS)).toBe("01:30");
  });
});

describe("甘特轴", () => {
  it("floorToMonday：周一自身不动，周日退六天，跨月也按 UTC 日期退", () => {
    expect(ymd(floorToMonday(new Date(Date.UTC(2026, 2, 2))))).toBe("2026-03-02"); // 周一
    expect(ymd(floorToMonday(new Date(Date.UTC(2026, 2, 8))))).toBe("2026-03-02"); // 周日
    expect(ymd(floorToMonday(new Date(Date.UTC(2026, 3, 1))))).toBe("2026-03-30"); // 周三跨月
  });
  it("cstAxisDateFromIso：ISO 时刻平移 +8h 后读 UTC 部件就是 CST 墙上日期", () => {
    expect(ymd(cstAxisDateFromIso(CROSS))).toBe("2026-03-02");
    expect(ymd(cstAxisDateFromIso("2026-03-01T15:59:59.000Z"))).toBe("2026-03-01");
  });
  it("dateOnlyAxisMs：纯日期按 UTC 构造，日末为 23:59:59.999", () => {
    expect(dateOnlyAxisMs("2026-03-02")).toBe(Date.UTC(2026, 2, 2));
    expect(dateOnlyAxisMs("2026-03-02", true)).toBe(Date.UTC(2026, 2, 2, 23, 59, 59, 999));
    expect(dateOnlyAxisMs("2026-03-02", true) - dateOnlyAxisMs("2026-03-02")).toBe(DAY_MS - 1);
  });
  it("addDaysIso：按整天平移，负数可退", () => {
    expect(addDaysIso(CROSS, 1)).toBe("2026-03-02T17:30:00.000Z");
    expect(addDaysIso(CROSS, -1)).toBe("2026-02-28T17:30:00.000Z");
  });
});

describe("执行日程时间轴", () => {
  it("minutesOfIso 是 CST 当天分钟数；fmtMin 反向补零", () => {
    expect(minutesOfIso(CROSS)).toBe(90);
    expect(fmtMin(90)).toBe("01:30");
    expect(fmtMin(0)).toBe("00:00");
    expect(fmtMin(23 * 60 + 5)).toBe("23:05");
  });
  it("withTime 保留 CST 日期、换成给定 CST 时分", () => {
    // CROSS 的 CST 日期是 03-02；换成 CST 09:00 = UTC 01:00
    expect(withTime(CROSS, "09:00")).toBe("2026-03-02T01:00:00.000Z");
    // 换成 CST 00:30 仍是 03-02，不能退回 03-01
    expect(withTime(CROSS, "00:30")).toBe("2026-03-01T16:30:00.000Z");
  });
});
