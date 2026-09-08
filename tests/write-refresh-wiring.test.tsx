import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { ROOT, closure } from "./module-graph";

/**
 * #416 接线把关。
 *
 * `lib/write-refresh` 是模块级的，要有人在运行时把 router 交给它。少了那次注册，
 * `writeFetch` / `refreshNow` **全部静默变成空操作**：白名单页面的写会被打回，
 * 而且换掉了显式 `router.refresh()` 的那些调用点连界面都不再更新。
 *
 * 这个失效模式极其隐蔽——tsc、eslint、next build 全都发现不了，
 * write-refresh 的单元测试也发现不了（它们自己调 registerWriteRefreshRouter，
 * 正好把要验的那一层 mock 掉了）。本 PR 中途重建分支时就真的丢过一次这行注册，
 * 全套检查依然全绿，是 AI review 抓出来的。所以单独立一条静态断言盯着它。
 */

describe("#416 write-refresh 接线", () => {
  it("root layout 的闭包里有人调 registerWriteRefreshRouter", () => {
    const callers = closure(["app/layout.tsx"]).filter(f => {
      if (f === "lib/write-refresh.ts") return false; // 定义处不算
      return /registerWriteRefreshRouter\s*\(/.test(fs.readFileSync(path.join(ROOT, f), "utf8"));
    });
    expect(
      callers,
      "没有任何 root layout 下的组件注册 router。\n" +
        "writeFetch / refreshNow 会全部变成空操作，且不会有任何检查报错。\n" +
        "应在 components/AppShell.tsx 里：\n" +
        "  useEffect(() => registerWriteRefreshRouter(router), [router]);",
    ).not.toEqual([]);
  });

  it("注册发生在 effect 里，且注销函数被交回给 React", () => {
    const src = fs.readFileSync(path.join(ROOT, "components/AppShell.tsx"), "utf8");
    // 直接返回 register 的结果 = 把注销函数交给 React 作为 cleanup
    expect(src).toMatch(/useEffect\(\s*\(\)\s*=>\s*registerWriteRefreshRouter\(/);
  });
});
