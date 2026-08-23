// 飞书剪贴板 HTML 归一化 —— 粘贴接入第一批：junk 清理 + 简单映射。
// 形态依据：本地 probe 五次实测采样（MindWeave《飞书复制粘贴调研》§6），
// 非猜测。纪律：只在识别为飞书来源时介入；漏判/识别失败的代价只是丢样式
// 不丢文字（一律降级为纯文本，不吃内容）。callout 与图片在后续批次。

export type FeishuMember = { userId: string; name: string };

/** 剪贴板 HTML 是否来自飞书（文档 root 标记 / 电子表格块 / @提及属性） */
export function isFeishuHtml(html: string): boolean {
  return /data-lark-html-role="root"|<byte-sheet-html-origin|data-lark-atuser=|zoneType-calloutBlock/.test(html);
}

/**
 * 归一化飞书粘贴 HTML。仅在浏览器端调用（依赖 DOMParser）。
 * 任何一步失败都应由调用方兜底回原 HTML——宁可少归一化，不可拦粘贴。
 */
export function transformFeishuHtml(html: string, opts: { members?: FeishuMember[] } = {}): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const body = doc.body;
  stripBlockPlaceholders(body);
  mapCallouts(doc, body);
  normalizeCodeBlocks(body);
  normalizeChecklists(body);
  mapAtMentions(doc, body, opts.members ?? []);
  replaceVideos(doc, body);
  return body.innerHTML;
}

// ── callout：映射到 wiki callout 方言的 HTML 形态（lib/tiptap-callout）────────
// 实测形态：<div class="zoneType-calloutBlock"><div class="callout-container"
//   data-emoji-id="cake"><div class="callout-block" style="background-color:…;
//   border-color:…"><div class="ace-line">内容行</div>…
// 识别认结构特征（data-emoji-id 容器 + 内层内联背景色块），不认 class 名——
// 飞书改版时漏判的代价只是降级成普通段落，不吃内容。

// 飞书 data-emoji-id 是标准 emoji shortcode；只映射 callout 常用集，
// 未收录的落默认 💡（emoji 只是视觉记号，语义在内容里）
const FEISHU_EMOJI: Record<string, string> = {
  bulb: "💡", pushpin: "📌", star: "⭐", star2: "🌟", fire: "🔥",
  warning: "⚠️", exclamation: "❗", question: "❓",
  white_check_mark: "✅", heavy_check_mark: "✔️", x: "❌",
  memo: "📝", book: "📖", books: "📚", dart: "🎯", bell: "🔔",
  loudspeaker: "📢", mega: "📣", speech_balloon: "💬", bookmark: "🔖",
  cake: "🍰", chestnut: "🌰", trophy: "🏆", gift: "🎁", rocket: "🚀",
  eyes: "👀", point_right: "👉", thumbsup: "👍", "+1": "👍", heart: "❤️",
  sparkles: "✨", calendar: "📅", alarm_clock: "⏰", hourglass: "⏳",
  link: "🔗", lock: "🔒", key: "🔑", gear: "⚙️", wrench: "🔧",
  bug: "🐛", package: "📦", file_folder: "📁", clipboard: "📋",
};

// 飞书默认灰底——与我们方言的默认底色等价，不落颜色，保持 marker 最短形态
const FEISHU_DEFAULT_BG = "#f5f6f7";

function cssColorToHex(v: string): string | null {
  const m = v.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
  if (m) return "#" + [m[1], m[2], m[3]].map(n => Number(n).toString(16).padStart(2, "0")).join("");
  const t = v.trim();
  return /^#[0-9a-fA-F]{3,8}$/.test(t) ? t : null;
}

function mapCallouts(doc: Document, body: HTMLElement) {
  for (const container of Array.from(body.querySelectorAll("div[data-emoji-id]"))) {
    const inner = Array.from(container.children).find(
      el => el instanceof HTMLElement && el.style.backgroundColor,
    ) as HTMLElement | undefined;
    const content = inner ?? container;
    const emoji = FEISHU_EMOJI[container.getAttribute("data-emoji-id") ?? ""] ?? "💡";
    const bg = inner ? cssColorToHex(inner.style.backgroundColor) : null;
    const out = doc.createElement("div");
    out.setAttribute("data-callout", "");
    out.setAttribute("data-emoji", emoji);
    if (bg && bg.toLowerCase() !== FEISHU_DEFAULT_BG) out.setAttribute("data-color", bg);
    while (content.firstChild) out.appendChild(content.firstChild);
    // 外层 zoneType 包裹一并替换掉，避免残留空容器
    (container.closest(".zoneType-calloutBlock") ?? container).replaceWith(out);
  }
}

// ── junk：ISV 等无法外显的块 ──────────────────────────────────────────────────
// 实测形态：<span class="… block-type-ISV_BLOCK block-placeholder">…
//   <span class="block-paste-placeholder">暂时无法在飞书文档外展示此内容</span>…
// 整块删除（占位文案对我们的文档是纯噪音）。
function stripBlockPlaceholders(body: HTMLElement) {
  for (const el of Array.from(body.querySelectorAll(".block-placeholder, .block-paste-placeholder"))) {
    // 优先删外层 .block-placeholder 容器；内层选择器兜底孤立出现的占位文案
    el.remove();
  }
}

// ── 代码块：拆掉 code 内层 div 包裹 ───────────────────────────────────────────
// 实测形态：<pre><code class="language-C++"><div>…多行含真实换行…</div></code></pre>
// 结构本身标准（语言类名正是 TipTap 默认认的 language- 前缀），只需把 div
// 层展平成纯文本，避免解析器把 div 边界当块边界吞换行。
function normalizeCodeBlocks(body: HTMLElement) {
  for (const code of Array.from(body.querySelectorAll("pre code"))) {
    const divs = Array.from(code.children).filter(el => el.tagName === "DIV");
    if (divs.length === 0) continue;
    code.textContent = divs.map(d => d.textContent ?? "").join("\n");
  }
}

// ── checklist：映射到 TipTap TaskList/TaskItem 的标准 HTML 形态 ───────────────
// 实测形态：<ul class="list-check1"><li data-list="check"><div>文字</div></li>
// 已勾选态尚未采样（probe 样本全为未勾选）——按 done/checked 词防御性识别。
function normalizeChecklists(body: HTMLElement) {
  for (const li of Array.from(body.querySelectorAll("li[data-list]"))) {
    const v = li.getAttribute("data-list") ?? "";
    if (!/^(check|done|checked)$/.test(v)) continue;
    li.setAttribute("data-type", "taskItem");
    li.setAttribute("data-checked", v === "check" ? "false" : "true");
    const list = li.parentElement;
    if (list && (list.tagName === "UL" || list.tagName === "OL")) {
      list.setAttribute("data-type", "taskList");
    }
  }
}

// ── @提及：按 username 匹配本制作成员 ─────────────────────────────────────────
// 实测形态：<a data-lark-atuser='{"userid":"…","username":"名字","avatar_url":…}'>
// 飞书 userid 对我们无意义（飞书身份已退役）；username 精确且唯一命中成员
// → 落 atMention 节点标准 HTML（AtMentionExt parseHTML 认 span[data-type]），
// 未命中/重名 → 纯文本 @名字，零丢失。
function mapAtMentions(doc: Document, body: HTMLElement, members: FeishuMember[]) {
  for (const a of Array.from(body.querySelectorAll("a[data-lark-atuser]"))) {
    let username = "";
    try {
      const parsed = JSON.parse(a.getAttribute("data-lark-atuser") ?? "{}") as { username?: string };
      username = (parsed.username ?? "").trim();
    } catch { /* 属性损坏则走文本兜底 */ }
    if (!username) username = (a.textContent ?? "").replace(/^@/, "").trim();
    const matches = members.filter(m => m.name === username);
    if (username && matches.length === 1) {
      const span = doc.createElement("span");
      span.setAttribute("data-type", "atMention");
      span.setAttribute("data-id", matches[0].userId);
      span.setAttribute("data-label", username);
      span.textContent = `@${username}`;
      a.replaceWith(span);
    } else {
      a.replaceWith(doc.createTextNode(username ? `@${username}` : (a.textContent ?? "")));
    }
  }
}

// ── 视频：drivetoken:// 死引用，降级为带文件名的文本占位 ──────────────────────
// 实测形态：<video data-lark-video-uri="drivetoken://…" data-lark-video-name="家.mp4">
function replaceVideos(doc: Document, body: HTMLElement) {
  for (const v of Array.from(body.querySelectorAll("video"))) {
    const name = v.getAttribute("data-lark-video-name");
    const p = doc.createElement("p");
    p.textContent = name ? `[飞书视频：${name}]` : "[飞书视频]";
    v.replaceWith(p);
  }
}
