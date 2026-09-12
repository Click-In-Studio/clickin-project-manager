// 联网工具（#367 切换后补齐）：网关时代 web_search / web_fetch 是 OpenClaw 内置的
// （Brave 搜索 + 抓页），自建运行时没有它们 = 模型失去联网能力。这里按同样的形态
// 自己实现：搜索走 Brave Web Search API（key 与网关同一个），抓页是带 SSRF 防护、
// 超时与体积上限的 GET + HTML 抽正文。两者都是只读，不过审批门。

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Agent, fetch as undiciFetch } from "undici";

export const WEB_SEARCH_MAX = 5;
export const WEB_FETCH_TIMEOUT_MS = 15_000;
export const WEB_FETCH_MAX_BYTES = 2 * 1024 * 1024;
export const WEB_FETCH_MAX_CHARS = 20_000;

// ── 搜索 ────────────────────────────────────────────────────────────────────

export interface SearchHit { title: string; url: string; snippet: string }

export async function webSearch(query: string, count = WEB_SEARCH_MAX, signal?: AbortSignal): Promise<SearchHit[]> {
  const key = process.env.BRAVE_API_KEY;
  if (!key) throw new WebToolError("联网搜索未配置（缺 BRAVE_API_KEY）。请告诉用户当前无法联网搜索，基于已有信息回答。");
  const u = new URL("https://api.search.brave.com/res/v1/web/search");
  u.searchParams.set("q", query);
  u.searchParams.set("count", String(Math.min(Math.max(count, 1), 10)));
  const res = await fetch(u, {
    headers: { Accept: "application/json", "Accept-Encoding": "gzip", "X-Subscription-Token": key },
    signal: withTimeout(signal, WEB_FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new WebToolError(`搜索服务返回 ${res.status}${res.status === 429 ? "（配额用尽）" : ""}`);
  const data = (await res.json()) as { web?: { results?: Array<{ title?: string; url?: string; description?: string }> } };
  return (data.web?.results ?? []).slice(0, count).map((r) => ({
    title: (r.title ?? "").trim(),
    url: r.url ?? "",
    snippet: stripTags(r.description ?? "").trim(),
  }));
}

export function formatSearchHits(query: string, hits: SearchHit[]): string {
  if (hits.length === 0) return `「${query}」没有搜索结果。`;
  return hits.map((h, i) => `${i + 1}. ${h.title}\n   ${h.url}\n   ${h.snippet}`).join("\n");
}

// ── 抓页 ────────────────────────────────────────────────────────────────────

export interface FetchedPage { url: string; title: string; text: string; truncated: boolean }

export async function webFetch(rawUrl: string, signal?: AbortSignal): Promise<FetchedPage> {
  let url: URL;
  try { url = new URL(rawUrl); } catch { throw new WebToolError("URL 不合法"); }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new WebToolError("只支持 http/https");
  assertHostnameAllowed(url.hostname);

  // SSRF 防护落在连接层：dispatcher 的 lookup 就是真正建连用的那次解析，解析结果先过
  // isPrivateAddress 再连——先查后连两次独立解析的 DNS rebinding 绕过在这里不存在；
  // 重定向的每一跳同样经这个 lookup 建连，302 到内网在发请求之前就被拒（AI review #373）。
  // 重定向手动跟：net.connect 对字面 IP 不会调 lookup，所以每一跳的目标都先过一遍
  // assertHostnameAllowed（字面 IP 的私网判定在这里），域名的私网判定则在建连时的 lookup 里。
  const dispatcher = guardedDispatcher();
  const abort = withTimeout(signal, WEB_FETCH_TIMEOUT_MS);
  let current = url;
  let res: Awaited<ReturnType<typeof undiciFetch>>;
  for (let hop = 0; ; hop++) {
    assertHostnameAllowed(current.hostname);
    try {
      res = await undiciFetch(current, {
        dispatcher,
        redirect: "manual",
        headers: { "User-Agent": "Mozilla/5.0 (compatible; ClickInAgent/1.0)", Accept: "text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.5" },
        signal: abort,
      });
    } catch (err) {
      const cause = (err as { cause?: unknown }).cause;
      if (cause instanceof WebToolError) throw cause;
      throw err;
    }
    const location = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && location) {
      await res.body?.cancel().catch(() => {});
      if (hop >= 5) throw new WebToolError("重定向次数过多");
      current = new URL(location, current);
      if (current.protocol !== "http:" && current.protocol !== "https:") throw new WebToolError("只支持 http/https");
      continue;
    }
    break;
  }
  if (!res.ok) throw new WebToolError(`抓取失败：HTTP ${res.status}`);

  const body = await readCapped(res, WEB_FETCH_MAX_BYTES);
  const ctype = res.headers.get("content-type") ?? "";
  let title = "";
  let text: string;
  if (/html|xml/i.test(ctype) || /^\s*<(!doctype|html)/i.test(body.slice(0, 200))) {
    ({ title, text } = htmlToText(body));
  } else {
    text = body;
  }
  const truncated = text.length > WEB_FETCH_MAX_CHARS;
  return { url: current.href, title, text: truncated ? text.slice(0, WEB_FETCH_MAX_CHARS) : text, truncated };
}

export function formatFetchedPage(p: FetchedPage): string {
  const head = p.title ? `标题：${p.title}\n来源：${p.url}` : `来源：${p.url}`;
  return `${head}\n\n${p.text}${p.truncated ? `\n\n[正文超过 ${WEB_FETCH_MAX_CHARS} 字已截断]` : ""}`;
}

/** 极简 HTML → 文本：去 script/style/noscript/template，块级标签换行，实体解码，空白折叠。 */
export function htmlToText(html: string): { title: string; text: string } {
  const title = decodeEntities(stripTags(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "")).replace(/\s+/g, " ").trim();
  let s = html
    .replace(/<(script|style|noscript|template|svg|iframe)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/(p|div|section|article|li|tr|h[1-6]|blockquote|pre|header|footer|nav|main|aside|dd|dt|figure|figcaption)>/gi, "\n")
    .replace(/<(br|hr)\s*\/?>/gi, "\n")
    // 行内标签直接抹掉（不留空格），否则「提示：<b>暗场</b>」会变成「提示： 暗场」
    .replace(/<\/?(a|b|i|u|s|em|strong|span|code|small|sup|sub|mark|abbr|cite|q|time|label)\b[^>]*>/gi, "");
  s = decodeEntities(stripTags(s));
  const text = s.split("\n").map((l) => l.replace(/[ \t ]+/g, " ").trim()).filter(Boolean).join("\n");
  return { title, text };
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, " ");
}

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"").replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)));
}

/** 按字节上限读体。截断点落在多字节字符中间时那个字符会解成 �——正文只是给模型看的，best-effort。 */
async function readCapped(res: { body: unknown }, max: number): Promise<string> {
  const reader = (res.body as ReadableStream<Uint8Array> | null)?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) { chunks.push(value.subarray(0, value.byteLength - (total - max))); await reader.cancel().catch(() => {}); break; }
    chunks.push(value);
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(Buffer.concat(chunks));
}

function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const t = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, t]) : t;
}

// ── SSRF 防护 ───────────────────────────────────────────────────────────────
//
// AGENT_WEB_FETCH_ALLOW_PRIVATE：只给测试。"1" = 全放行；也可以是逗号分隔的主机名白名单
// （如 "127.0.0.1"），这样测试能同时验证"白名单内可抓、重定向到白名单外的内网被拒"。

function privateAllowlist(): "all" | Set<string> {
  const v = process.env.AGENT_WEB_FETCH_ALLOW_PRIVATE;
  if (!v) return new Set();
  if (v === "1") return "all";
  return new Set(v.split(",").map((h) => h.trim().toLowerCase()).filter(Boolean));
}

function normalizeHost(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, "").toLowerCase();
}

/** 主机名层面的拒绝（不用解析就能判的） */
export function assertHostnameAllowed(hostname: string): void {
  const host = normalizeHost(hostname);
  const allow = privateAllowlist();
  if (allow === "all" || allow.has(host)) return;
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    throw new WebToolError("不允许抓取内网地址");
  }
  // 字面 IP：net.connect 不会为它调 lookup，私网判定只能在这里做
  if (isIP(host) && isPrivateAddress(host)) throw new WebToolError("不允许抓取内网地址");
}

type LookupCb = (err: NodeJS.ErrnoException | null, address: string, family: number) => void;

/** 建连用的 lookup：解析 → 逐地址判私网 → 只把通过的地址交给 socket。 */
function guardedLookup(hostname: string, _opts: unknown, cb: LookupCb): void {
  const host = normalizeHost(hostname);
  const allow = privateAllowlist();
  const allowed = allow === "all" || allow.has(host);
  try { assertHostnameAllowed(host); } catch (err) { cb(err as Error, "", 0); return; }
  const resolve = isIP(host) ? Promise.resolve([{ address: host, family: isIP(host) }]) : lookup(host, { all: true });
  resolve.then((addrs) => {
    if (addrs.length === 0) { cb(new WebToolError("域名无法解析"), "", 0); return; }
    const a = addrs[0];
    if (!allowed && isPrivateAddress(a.address)) { cb(new WebToolError("不允许抓取内网地址"), "", 0); return; }
    cb(null, a.address, a.family);
  }, () => cb(new WebToolError("域名无法解析"), "", 0));
}

function guardedDispatcher(): Agent {
  return new Agent({ connect: { lookup: guardedLookup as unknown as undefined } });
}

/** 供测试/其他调用方单独判一个主机名（解析 + 私网判定），与建连用的判据同一份。 */
export async function assertPublicHost(hostname: string): Promise<void> {
  await new Promise<void>((resolve, reject) => guardedLookup(hostname, {}, (err) => (err ? reject(err) : resolve())));
}

export function isPrivateAddress(ip: string): boolean {
  if (ip.includes(":")) {
    const v = ip.toLowerCase();
    if (v === "::1" || v === "::" ) return true;
    if (v.startsWith("fc") || v.startsWith("fd")) return true;           // fc00::/7
    if (v.startsWith("fe80")) return true;                                // 链路本地
    const m = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);                   // v4 映射
    return m ? isPrivateAddress(m[1]) : false;
  }
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => Number.isNaN(n))) return true;
  if (p[0] === 10 || p[0] === 127 || p[0] === 0) return true;
  if (p[0] === 169 && p[1] === 254) return true;
  if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
  if (p[0] === 192 && p[1] === 168) return true;
  if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return true;             // CGNAT / tailscale
  return false;
}

export class WebToolError extends Error {}
