/**
 * 侧栏「在途项」的状态归约。
 *
 * 单独放在 lib 下而不是内联在 AppShell 里：这是本机制唯一非平凡的逻辑，
 * 连点时几个 report 的到达顺序不确定，值得有测试兜住（见
 * tests/nav-pending.test.ts）。
 *
 * 各 NavItem 通过 useLinkStatus 上报自己的在途状态，汇聚成「当前正在去哪」
 * 这一个值。约束：
 *   - 有项在途 → 它就是答案（后点的顶掉先点的）
 *   - 某项撤回 → 只有当它正是当前在途项时才清空，否则不动。
 *     这条是连点安全的关键：点 A 再点 B 时，A 的撤回可能晚于 B 的上报到达，
 *     此时 prev 已是 B，必须无视这次撤回，否则高亮会瞬间掉回原页面。
 */
export function nextNavPendingHref(
  prev: string | null,
  href: string,
  pending: boolean,
): string | null {
  if (pending) return href;
  return prev === href ? null : prev;
}
