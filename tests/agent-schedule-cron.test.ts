import { describe, it, expect } from "vitest";
import { parseCron, nextCronFire, nextFireAt, validateSchedule, describeSchedule, wallClock, wallToInstant, formatInTz } from "@/lib/agent-runtime/schedule-cron";
import { SCHEDULE_LIMITS } from "@/lib/plan";

// 定时任务时间表（纯函数）：cron 解析、按 tz 墙钟算下一次、成本闸校验、人话。

const TZ = "Asia/Shanghai";
const at = (iso: string) => new Date(iso);

describe("parseCron", () => {
  it("五段、*/n、范围、列表、周日 7=0", () => {
    const s = parseCron("0 23 * * 1-5");
    expect([...s.minute]).toEqual([0]);
    expect([...s.hour]).toEqual([23]);
    expect(s.domRestricted).toBe(false);
    expect([...s.dow].sort()).toEqual([1, 2, 3, 4, 5]);
    expect([...parseCron("*/15 9,18 1 * 7").minute]).toEqual([0, 15, 30, 45]);
    expect([...parseCron("*/15 9,18 1 * 7").dow]).toEqual([0]);
  });
  it("非法表达式抛错", () => {
    expect(() => parseCron("0 23 * *")).toThrow(/5 段/);
    expect(() => parseCron("60 * * * *")).toThrow(/超出范围/);
    expect(() => parseCron("a * * * *")).toThrow(/不合法/);
  });
});

describe("时区换算", () => {
  it("墙钟 ↔ 瞬时（上海 +8）", () => {
    const t = wallToInstant(2026, 9, 1, 23, 0, TZ);
    expect(t.toISOString()).toBe("2026-09-01T15:00:00.000Z");
    expect(wallClock(t, TZ)).toMatchObject({ y: 2026, mo: 9, d: 1, h: 23, mi: 0, dow: 2 }); // 周二
    expect(formatInTz(t)).toBe("2026-09-01 23:00");
  });
  it("跨夏令时的时区也能算对（纽约 2026-03-08 02:30 不存在 → 落到 03:30 EDT）", () => {
    const t = wallToInstant(2026, 3, 8, 2, 30, "America/New_York");
    expect(wallClock(t, "America/New_York").h).toBe(3);
  });
});

describe("nextCronFire / nextFireAt", () => {
  it("每天 23:00（上海墙钟）：严格晚于 after；当天已过就是明天", () => {
    const spec = parseCron("0 23 * * *");
    expect(nextCronFire(spec, TZ, at("2026-09-01T10:00:00+08:00"))!.toISOString()).toBe("2026-09-01T15:00:00.000Z");
    expect(nextCronFire(spec, TZ, at("2026-09-01T23:00:00+08:00"))!.toISOString()).toBe("2026-09-02T15:00:00.000Z"); // 等于不算
    expect(nextCronFire(spec, TZ, at("2026-09-01T23:30:00+08:00"))!.toISOString()).toBe("2026-09-02T15:00:00.000Z");
  });
  it("周一 09:00：从周三起算落到下周一；dom 与 dow 同时受限取或", () => {
    expect(nextCronFire(parseCron("0 9 * * 1"), TZ, at("2026-09-02T12:00:00+08:00"))!.toISOString()).toBe("2026-09-07T01:00:00.000Z"); // 2026-09-07 周一 09:00 CST
    // 每月 1 日 或 周五，从 9/2（周三）起 → 9/4 周五
    expect(nextCronFire(parseCron("0 9 1 * 5"), TZ, at("2026-09-02T12:00:00+08:00"))!.toISOString()).toBe("2026-09-04T01:00:00.000Z");
  });
  it("永不触发（2 月 30 日）→ null", () => {
    expect(nextCronFire(parseCron("0 9 30 2 *"), TZ, at("2026-09-01T00:00:00Z"))).toBeNull();
  });
  it("at / every", () => {
    expect(nextFireAt({ kind: "at", at: "2026-09-01T01:00:00.000Z" }, at("2026-08-31T00:00:00Z"))!.toISOString()).toBe("2026-09-01T01:00:00.000Z");
    expect(nextFireAt({ kind: "at", at: "2026-09-01T01:00:00.000Z" }, at("2026-09-02T00:00:00Z"))).toBeNull();
    expect(nextFireAt({ kind: "every", everyMs: 3_600_000 }, at("2026-09-01T00:00:00Z"))!.toISOString()).toBe("2026-09-01T01:00:00.000Z");
  });
});

describe("validateSchedule（成本闸在 lib/plan.ts）", () => {
  const now = at("2026-08-30T12:00:00Z");
  it("规范化：cron 默认上海时区；at 转 ISO；every 取整", () => {
    expect(validateSchedule({ kind: "cron", expr: " 0 23 * * * " }, now)).toMatchObject({ ok: true, schedule: { kind: "cron", expr: "0 23 * * *", tz: TZ }, firesPerDay: 1 });
    expect(validateSchedule({ kind: "at", at: "2026-09-01T09:00:00+08:00" }, now)).toMatchObject({ ok: true, schedule: { kind: "at", at: "2026-09-01T01:00:00.000Z" } });
    expect(validateSchedule({ kind: "every", everyMs: 7_200_000.4 }, now)).toMatchObject({ ok: true, schedule: { kind: "every", everyMs: 7_200_000 } });
  });
  it("拒：过去的 at、超一年的 at、太勤的 every、太勤的 cron、永不触发、坏时区、坏 kind", () => {
    expect(validateSchedule({ kind: "at", at: "2026-08-01T00:00:00Z" }, now)).toMatchObject({ ok: false, error: expect.stringContaining("未来") });
    expect(validateSchedule({ kind: "at", at: "2028-01-01T00:00:00Z" }, now)).toMatchObject({ ok: false, error: expect.stringContaining("一年") });
    expect(validateSchedule({ kind: "every", everyMs: SCHEDULE_LIMITS.minIntervalMs - 1 }, now)).toMatchObject({ ok: false, error: expect.stringContaining("分钟") });
    expect(validateSchedule({ kind: "cron", expr: "*/5 * * * *" }, now)).toMatchObject({ ok: false, error: expect.stringContaining("超过上限") });
    expect(validateSchedule({ kind: "cron", expr: "0 9 30 2 *" }, now)).toMatchObject({ ok: false, error: expect.stringContaining("不会触发") });
    expect(validateSchedule({ kind: "cron", expr: "0 9 * * *", tz: "Mars/Olympus" }, now)).toMatchObject({ ok: false, error: expect.stringContaining("时区") });
    expect(validateSchedule({ kind: "weekly" }, now)).toMatchObject({ ok: false });
    expect(validateSchedule(null, now)).toMatchObject({ ok: false });
  });
  it("每小时一次（24/日）刚好在上限内", () => {
    expect(validateSchedule({ kind: "cron", expr: "0 * * * *" }, now)).toMatchObject({ ok: true, firesPerDay: 24 });
  });
});

describe("describeSchedule", () => {
  it("常见形态出人话，其余回退表达式", () => {
    expect(describeSchedule({ kind: "cron", expr: "0 23 * * *", tz: TZ })).toBe("每天 23:00");
    expect(describeSchedule({ kind: "cron", expr: "30 9 * * 1,3", tz: TZ })).toBe("每周一、三 09:30");
    expect(describeSchedule({ kind: "cron", expr: "0 8 1,15 * *", tz: TZ })).toBe("每月 1、15 日 08:00");
    expect(describeSchedule({ kind: "cron", expr: "0 9 * * *", tz: "Europe/London" })).toBe("每天 09:00（Europe/London）");
    expect(describeSchedule({ kind: "cron", expr: "*/30 * * * *", tz: TZ })).toBe("cron */30 * * * *（Asia/Shanghai）");
    expect(describeSchedule({ kind: "every", everyMs: 2 * 3_600_000 })).toBe("每 2 小时");
    expect(describeSchedule({ kind: "every", everyMs: 24 * 3_600_000 })).toBe("每 1 天");
    expect(describeSchedule({ kind: "at", at: "2026-09-01T01:00:00.000Z" })).toBe("2026-09-01 09:00 一次（Asia/Shanghai）");
  });
});
