import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const planningClient = readFileSync("components/ops/PlanningClient.tsx", "utf8");
const ganttView = readFileSync("components/ops/planning/TaskGanttView.tsx", "utf8");
const css = readFileSync("components/ops/planning.module.css", "utf8");

describe("计划页移动端控制区", () => {
  it("主视图页签保留三个完整入口，并把响应式外观交给语义 class", () => {
    for (const label of ["项目日历", "任务甘特", "执行日程"]) {
      expect(planningClient).toContain(label);
    }
    expect(planningClient).toContain("className={styles.planningShell}");
    expect(planningClient).toContain("className={styles.planningViewTab}");
    expect(planningClient).toContain("className={styles.planningTabLabel}");
    expect(planningClient).not.toContain('border: `1px solid ${mode === id');
  });

  it("任务甘特保留全部粒度和状态，并把控制条接到可换行 class", () => {
    expect(ganttView).toContain('aria-label="时间轴粒度"');
    expect(ganttView).toContain('aria-label="任务状态图例"');
    for (const option of ['["day", "日"]', '["month", "月"]', '["quarter", "季"]', '["year", "年"]']) {
      expect(ganttView).toContain(option);
    }
    for (const label of ["进行中", "待处理", "受阻", "完成"]) {
      expect(ganttView).toContain(label);
    }
    expect(ganttView).toContain("className={styles.ganttControls}");
    expect(ganttView).toContain("className={styles.ganttScaleButton}");
    expect(ganttView).toContain("className={styles.ganttLegend}");
  });

  it("760px 以下压缩卡片并让粒度与图例在 319px 宽度内分行", () => {
    const mobileStart = css.indexOf("@media (max-width: 760px)");
    const mobileEnd = css.indexOf("@media (max-width: 520px)");
    expect(mobileStart).toBeGreaterThan(-1);
    expect(mobileEnd).toBeGreaterThan(mobileStart);
    const mobileRules = css.slice(mobileStart, mobileEnd);
    expect(mobileRules).toMatch(/\.planningViewTab \{[^}]*min-height: 44px;[^}]*padding: 7px 6px;/);
    expect(mobileRules).toMatch(/\.ganttPanel \{ padding: 14px 10px; \}/);
    expect(mobileRules).toMatch(/\.ganttControls \{[^}]*width: 100%;[^}]*flex-shrink: 1;/);
    expect(mobileRules).toMatch(/\.ganttScale \{[^}]*width: 100%;[^}]*box-sizing: border-box;/);
    expect(mobileRules).toMatch(/\.ganttScaleButton \{[^}]*min-height: 44px;[^}]*flex: 1 1 0;/);
    expect(mobileRules).toMatch(/\.ganttLegend \{[^}]*width: 100%;[^}]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);[^}]*display: grid;/);
  });

  it("桌面默认尺寸保持原有页签与甘特控制条布局", () => {
    const desktopRules = css.slice(0, css.indexOf("@media (prefers-reduced-motion: reduce)"));
    expect(desktopRules).toMatch(/\.planningViewTab \{[^}]*min-height: 62px;[^}]*padding: 12px 15px;/);
    expect(desktopRules).toMatch(/\.ganttPanel \{[^}]*padding: 22px;/);
    expect(desktopRules).toMatch(/\.ganttControls \{[^}]*margin-left: auto;[^}]*flex-shrink: 0;/);
    expect(desktopRules).toMatch(/\.ganttLegend \{ display: flex; gap: 12px;/);
  });
});
