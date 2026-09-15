// ─── Per-production cookies ───────────────────────────────────────────────────

export function readCookie(key: string): string | null {
  try {
    const m = document.cookie.match(new RegExp(`(?:^|;\\s*)${key}=([^;]*)`));
    return m ? decodeURIComponent(m[1]) : null;
  } catch { return null; }
}
export function writeCookie(key: string, value: string) {
  document.cookie = `${key}=${encodeURIComponent(value)}; path=/; max-age=31536000; SameSite=Lax`;
}

