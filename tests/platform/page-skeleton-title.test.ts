import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { pageTitleFor, EXTRA_PRODUCTION_TITLES } from "@/components/ui/page-skeleton-title";
import { CREATION_NAV, PRODUCTION_NAV } from "@/components/shell/app-shell/nav-config";

/** #652 骨架屏「正在打开「××」…」的页面名：与侧栏 / 菜单口径一致，没收录的返回 null。 */
describe("pageTitleFor", () => {
  it("项目内：首段对应侧栏三组的词", () => {
    expect(pageTitleFor("/production/p1")).toBe("我的工作");
    expect(pageTitleFor("/production/p1/")).toBe("我的工作");
    expect(pageTitleFor("/production/p1/script")).toBe("剧本");
    expect(pageTitleFor("/production/p1/events/ev_123/callsheet")).toBe("事件");
    expect(pageTitleFor("/production/p1/wiki/nd_abcdef")).toBe("知识库");
    expect(pageTitleFor("/production/p1/notifications")).toBe("我的通知");
    expect(pageTitleFor("/production/p1/characters")).toBe("构作");
  });

  it("项目内：配置中心按子页给名，子页未知回落到「配置中心」", () => {
    expect(pageTitleFor("/production/p1/admin")).toBe("配置中心");
    expect(pageTitleFor("/production/p1/admin/roles")).toBe("角色管理");
    expect(pageTitleFor("/production/p1/admin/nope")).toBe("配置中心");
  });

  it("项目外：/my/* 按绝对路径给名，子页归到父页", () => {
    expect(pageTitleFor("/")).toBe("我的工作");
    expect(pageTitleFor("/my/projects")).toBe("我的项目");
    expect(pageTitleFor("/my/tasks")).toBe("任务");
    expect(pageTitleFor("/my/tasks/t_123")).toBe("任务");
    expect(pageTitleFor("/my/weekly-call")).toBe("日程");
  });

  it("没收录的路径返回 null（骨架退回不带名字的「正在打开…」）", () => {
    expect(pageTitleFor("/production/p1/unknown-module")).toBeNull();
    expect(pageTitleFor("/account")).toBeNull();
    expect(pageTitleFor("")).toBeNull();
  });

  it("手写补充表不与侧栏 path 重名：重名时侧栏的词该赢，手写项应删掉而不是被静默盖过", () => {
    const navPaths = new Set<string>([...CREATION_NAV, ...PRODUCTION_NAV].map((n) => n.path));
    const collisions = Object.keys(EXTRA_PRODUCTION_TITLES).filter((k) => navPaths.has(k));
    expect(collisions).toEqual([]);
  });

  it("nav-config 必须是零依赖的纯常量：它经 ScriptEditor → PageSkeleton 进了客户端包（§13.3）", () => {
    const src = readFileSync("components/shell/app-shell/nav-config.ts", "utf8");
    expect(src).not.toMatch(/^\s*import\b/m);
    expect(src).not.toMatch(/require\(/);
  });
});
