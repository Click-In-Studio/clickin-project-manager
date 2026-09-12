import { describe, it, expect } from "vitest";
import { nextNavPendingHref } from "@/lib/nav-pending";

const A = "/production/p1/events";
const B = "/production/p1/tasks";

/**
 * 侧栏在途高亮的归约逻辑。各 NavItem 的 useLinkStatus 上报顺序不确定，
 * 这里把「连点」「撤回晚到」「无关项撤回」几种到达顺序都钉住——一旦回归，
 * 表现是高亮瞬间掉回原页面或卡在错误的项上，肉眼很难归因。
 */
describe("nextNavPendingHref", () => {
  it("空闲态下无人在途", () => {
    expect(nextNavPendingHref(null, A, false)).toBe(null);
  });

  it("点击某项即成为在途项", () => {
    expect(nextNavPendingHref(null, A, true)).toBe(A);
  });

  it("在途项自己落地 → 交还给 pathname 推导", () => {
    expect(nextNavPendingHref(A, A, false)).toBe(null);
  });

  it("后点的顶掉先点的", () => {
    expect(nextNavPendingHref(A, B, true)).toBe(B);
  });

  it("连点：先点项的撤回晚于后点项的上报 → 保持后点项", () => {
    // 点 A（prev=A），点 B（prev=B），此时 A 的 pending 才翻 false
    let s: string | null = null;
    s = nextNavPendingHref(s, A, true);
    s = nextNavPendingHref(s, B, true);
    s = nextNavPendingHref(s, A, false); // A 撤回晚到，不能清掉 B
    expect(s).toBe(B);
  });

  it("连点：先点项的撤回早于后点项的上报 → 仍落在后点项", () => {
    let s: string | null = null;
    s = nextNavPendingHref(s, A, true);
    s = nextNavPendingHref(s, A, false);
    s = nextNavPendingHref(s, B, true);
    expect(s).toBe(B);
  });

  it("无关项撤回不影响当前在途项", () => {
    expect(nextNavPendingHref(A, B, false)).toBe(A);
  });

  it("挂载时各项上报 false 不会扰动已有在途项", () => {
    // NavItem 挂载（如抽屉展开）时 effect 会先跑一次 report(href, false)
    let s: string | null = A;
    for (const href of ["/my/tasks", "/my/notifications", B]) {
      s = nextNavPendingHref(s, href, false);
    }
    expect(s).toBe(A);
  });
});
