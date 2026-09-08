import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { ROOT, closure, bareWrites, walkPages } from "./module-graph";

/**
 * #416 白名单把关。
 *
 * 页面导出 `unstable_dynamicStaleTime` 就等于宣称：**本页自己能触发的写操作，全部
 * 会失效 client router cache**。否则用户在本页写完切走、30 秒内切回来，组件会从写
 * 之前的 RSC payload 重新播种（本仓 `useState(initialX)` 的播种模式遍地都是），自己
 * 的写被静默打回。
 *
 * 闭包必须带上 `app/layout.tsx`：AppShell 及其下的 AgentPopout / AccessRequestModal /
 * usePendingPermissions 挂在每个页面上，它们的写点同样能从白名单页面触发。第一版把关
 * 测试只走 page 的 `@/components` 绝对导入，正好漏掉这一整支（AI review #3 指出）。
 */

const whitelisted = walkPages().filter(p =>
  /export const unstable_dynamicStaleTime\s*=/.test(fs.readFileSync(path.join(ROOT, p), "utf8")),
);

describe("#416 staleTime 白名单", () => {
  it("白名单非空——否则这条测试是在空转", () => {
    expect(whitelisted.length).toBeGreaterThan(0);
  });

  it.each(whitelisted)("%s：组件闭包内没有未失效缓存的写点", (page) => {
    // layout 是每页都挂的，它那一支的写点同样能从本页触发
    const offenders = closure([page, "app/layout.tsx"]).flatMap(bareWrites);
    expect(
      offenders,
      `这些写点用的是裸 fetch，不会失效 client router cache。\n` +
        `该页导出了 unstable_dynamicStaleTime，用户在本页写完切走再切回来会被打回。\n` +
        `改用 @/lib/write-refresh 的 writeFetch，或把该页从白名单里摘掉。\n` +
        `涉及：\n  ${offenders.join("\n  ")}`,
    ).toEqual([]);
  });
});
