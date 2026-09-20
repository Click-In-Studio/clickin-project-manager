// 更新日志「看过没有」（#569）：键是最新已发版本号，存 localStorage——只是每台设备
// 一次的小红点，不值得为它开 migration；换设备再看一次红点可接受。
// 客户端组件 import 这个文件，**不能** import lib/help/changelog.ts（那边带 node:fs，
// 进客户端 bundle 整站 500，见 feedback_client_import_node）。

export const CHANGELOG_SEEN_KEY = "backstage.changelog.seen";

/** 读到的可能是 null（没看过 / 隐私模式 / 存储被禁），一律当没看过。 */
export function readSeenChangelogVersion(): string | null {
  try {
    return window.localStorage.getItem(CHANGELOG_SEEN_KEY);
  } catch {
    return null;
  }
}

export function markChangelogSeen(version: string): void {
  try {
    window.localStorage.setItem(CHANGELOG_SEEN_KEY, version);
  } catch {
    // 存不了就每次都红，不影响功能
  }
}

/** 有最新版本、且与上次看过的不同 → 红点。没有任何版本（还没发过）不红。 */
export function hasUnseenChangelog(latest: string | null, seen: string | null): boolean {
  return latest !== null && latest !== seen;
}
