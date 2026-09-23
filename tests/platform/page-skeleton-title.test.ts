import { describe, it, expect } from "vitest";
import { pageTitleFor } from "@/components/ui/page-skeleton-title";

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
});
