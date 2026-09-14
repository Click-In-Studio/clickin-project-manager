// 视图偏好读写：禁用存储的 WKWebView / Safari 无痕下 localStorage 本身就会抛
// （取 window.localStorage 抛 SecurityError，setItem 抛 QuotaExceededError）。
// 在 useEffect 里抛出去就是整页白，偏好丢了远不如页面挂了严重——一律吞掉。
export function readPref(key: string): string | null {
  try { return window.localStorage.getItem(key); } catch { return null; }
}
export function writePref(key: string, value: string): void {
  try { window.localStorage.setItem(key, value); } catch { /* 存不下就算了，不影响本次会话 */ }
}
