// 页面感知注册表的纯函数测试：路由 → pageKey 推导、allowlist 语义（不在表里
// 的页面什么都不附带）、以及注册表自身的一致性（drift 防线）。
import { describe, it, expect } from "vitest";
import {
  derivePageKey,
  pageLabelFor,
  pageSuggestionsFor,
  __registry,
} from "@/lib/agent-page-context";

const PID = "abc123xy";

describe("derivePageKey", () => {
  it("项目内页面按首段取模块，项目首页为 prod:home", () => {
    expect(derivePageKey(`/production/${PID}`, PID)).toBe("prod:home");
    expect(derivePageKey(`/production/${PID}/`, PID)).toBe("prod:home");
    expect(derivePageKey(`/production/${PID}/tasks`, PID)).toBe("prod:tasks");
    expect(derivePageKey(`/production/${PID}/tasks/t42`, PID)).toBe("prod:tasks");
    expect(derivePageKey(`/production/${PID}/wiki/w1`, PID)).toBe("prod:wiki");
    expect(derivePageKey(`/production/${PID}/admin/permissions`, PID)).toBe("prod:admin");
    expect(derivePageKey(`/production/${PID}/events/e1/reqs/r1`, PID)).toBe("prod:events");
  });

  it("灵感文档破例认二段——它是文档库形态，不是构作场景视图", () => {
    expect(derivePageKey(`/production/${PID}/dramaturgy`, PID)).toBe("prod:dramaturgy");
    expect(derivePageKey(`/production/${PID}/dramaturgy/inspiration`, PID))
      .toBe("prod:dramaturgy-inspiration");
    expect(derivePageKey(`/production/${PID}/dramaturgy/inspiration/w1`, PID))
      .toBe("prod:dramaturgy-inspiration");
    // 归到构作那套＝模型以为自己在看场次/行动线，建议与温层工具面全错
    expect(pageLabelFor(derivePageKey(`/production/${PID}/dramaturgy/inspiration`, PID)))
      .toBe("构作 · 灵感文档");
    expect(pageSuggestionsFor(derivePageKey(`/production/${PID}/dramaturgy/inspiration`, PID)))
      .not.toHaveLength(0);
  });

  it("个人页面：/my/* 与首页/账号页", () => {
    expect(derivePageKey("/", null)).toBe("home");
    expect(derivePageKey("/my/tasks", null)).toBe("my:tasks");
    expect(derivePageKey("/my/daily-call", null)).toBe("my:daily-call");
    expect(derivePageKey("/account", null)).toBe("account");
  });

  it("不认识的路由返回 null（login/share/邀请页等不附带页面信息）", () => {
    expect(derivePageKey("/login", null)).toBeNull();
    expect(derivePageKey("/share/tok123", null)).toBeNull();
    expect(derivePageKey("/invite/tok123", null)).toBeNull();
    // productionId 为 null 时项目路径也不识别（语境不符，宁可不带）
    expect(derivePageKey(`/production/${PID}/tasks`, null)).toBeNull();
  });

  it("相邻前缀 id 不误归属：/production/<pid>xyz/… 不算 <pid> 的页面", () => {
    expect(derivePageKey(`/production/${PID}xyz/tasks`, PID)).toBeNull();
    expect(derivePageKey(`/production/${PID}xyz`, PID)).toBeNull();
  });
});

describe("pageLabelFor / pageSuggestionsFor（allowlist 语义）", () => {
  it("在表里的 key 有中文页面名", () => {
    expect(pageLabelFor("prod:tasks")).toBe("任务");
    expect(pageLabelFor("prod:home")).toBe("项目首页");
    expect(pageLabelFor("my:tasks")).toBe("我的任务");
  });

  it("不在表里的 key（未来新增的路由段）返回 null/空——不把原始 URL 片段送进模型", () => {
    expect(pageLabelFor("prod:some-future-module")).toBeNull();
    expect(pageLabelFor(null)).toBeNull();
    expect(pageSuggestionsFor("prod:some-future-module")).toEqual([]);
    expect(pageSuggestionsFor(null)).toEqual([]);
  });
});

describe("注册表一致性（drift 防线）", () => {
  const { PAGE_LABELS, PAGE_SUGGESTIONS } = __registry;

  it("有建议的页面必须也有页面名（否则建议 chip 出现而信封缺页面行）", () => {
    for (const key of Object.keys(PAGE_SUGGESTIONS)) {
      expect(PAGE_LABELS[key], `PAGE_SUGGESTIONS 的 key「${key}」不在 PAGE_LABELS 里`).toBeTruthy();
    }
  });

  it("label/prompt 非空，且不含 clickin- 分隔符（进信封的静态文本不许携带标签）", () => {
    for (const [key, suggestions] of Object.entries(PAGE_SUGGESTIONS)) {
      for (const s of suggestions) {
        expect(s.label.trim(), `${key} 的建议 label 为空`).not.toBe("");
        expect(s.prompt.trim(), `${key} 的建议 prompt 为空`).not.toBe("");
      }
    }
    for (const [key, label] of Object.entries(PAGE_LABELS)) {
      expect(label.trim(), `${key} 的页面名为空`).not.toBe("");
      expect(label.toLowerCase()).not.toContain("clickin-");
    }
  });
});
