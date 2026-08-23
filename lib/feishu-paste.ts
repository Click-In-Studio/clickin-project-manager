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
export function transformFeishuHtml(html: string, opts: { members?: FeishuMember[]; record?: string | null } = {}): string {
  if (typeof DOMParser === "undefined") {
    throw new Error("transformFeishuHtml 仅限浏览器端调用（依赖 DOMParser）");
  }
  const doc = new DOMParser().parseFromString(html, "text/html");
  const body = doc.body;
  stripBlockPlaceholders(body);
  mapGrids(doc, body, opts.record);
  mapCallouts(doc, body);
  normalizeCodeBlocks(body);
  normalizeChecklists(body);
  mapAtMentions(doc, body, opts.members ?? []);
  replaceFeishuImages(doc, body);
  replaceVideos(doc, body);
  return body.innerHTML;
}

// ── 图片：整篇粘贴路径降级为占位文本 ─────────────────────────────────────────
// 实测：飞书文档 HTML 里的 img src 是鉴权 URL（~1h 过期 token + 需飞书登录态
// + 水印），我们既过不了 CORS 也没有登录态，无法转存；data-snapshot(base64)
// 里有原文件名/尺寸，用它把占位做得有信息量。单图「复制图片」路径剪贴板携带
// 真文件，由编辑器 handlePaste 上传，不经此处。
function replaceFeishuImages(doc: Document, body: HTMLElement) {
  for (const img of Array.from(body.querySelectorAll("img"))) {
    const src = img.getAttribute("src") ?? "";
    const snapshotRaw = img.getAttribute("data-snapshot");
    if (snapshotRaw == null && !/feishu|larksuite/.test(src)) continue; // 非飞书图不动
    let name = "";
    let dims = "";
    if (snapshotRaw) {
      try {
        const bytes = Uint8Array.from(atob(snapshotRaw), c => c.charCodeAt(0));
        const snap = JSON.parse(new TextDecoder().decode(bytes)) as { image?: { name?: string; width?: number; height?: number } };
        name = snap.image?.name ?? "";
        if (snap.image?.width && snap.image?.height) dims = ` ${snap.image.width}×${snap.image.height}`;
      } catch { /* 元数据坏了就匿名占位 */ }
    }
    const p = doc.createElement("p");
    p.textContent = `[图片${name ? `：${name}` : ""}${dims} —— 请在飞书中对原图「复制图片」后粘贴到此处替换]`;
    img.replaceWith(p);
  }
}

// ── 分栏：经 docx/record 重组（HTML 出口把分栏拍平了）─────────────────────────
// 实测：飞书 text/html 里 <div data-type="grid"> 是空壳标记，栏内容块被展平
// 成顺序兄弟块（66/66 全在，只是失去分组）。但内容块的 old-record-id-* 类名
// 与 docx/record 私有格式的 block 树 id 一一对应——用 record 当结构真相源
// （grid → grid_column(width_ratio) → 子块 id），把散落的 DOM 块重新归栏，
// 落成 div[data-cols] > div[data-col]（lib/tiptap-columns 认这个形态）。
// 缺任何一块 → 整组放弃重组，维持拍平——降级可见，零内容损失。

type FeishuSnapshot = { type?: string; children?: string[]; width_ratio?: number };
type FeishuRecordMap = Record<string, { snapshot?: FeishuSnapshot }>;

function mapGrids(doc: Document, body: HTMLElement, record?: string | null) {
  if (!record) return;
  let rm: FeishuRecordMap;
  try {
    rm = (JSON.parse(record) as { recordMap?: FeishuRecordMap }).recordMap ?? {};
  } catch {
    return; // 私有格式读不懂就不重组，HTML 拍平形态照走
  }
  const byId = (id: string) => /^[\w-]+$/.test(id) ? body.querySelector(`[class*="old-record-id-${id}"]`) : null;

  for (const [gridId, rec] of Object.entries(rm)) {
    if (rec?.snapshot?.type !== "grid") continue;
    const marker = byId(gridId);
    if (!marker) continue;
    const colRecs = (rec.snapshot.children ?? [])
      .map(cid => rm[cid]?.snapshot)
      .filter((s): s is FeishuSnapshot => s?.type === "grid_column");
    if (colRecs.length < 2) continue;

    const cols: { ratio: number | null; els: Element[] }[] = [];
    let ok = true;
    for (const c of colRecs) {
      const els: Element[] = [];
      for (const kid of c.children ?? []) {
        const el = byId(kid);
        if (!el) { ok = false; break; }
        els.push(el);
      }
      if (!ok) break;
      cols.push({ ratio: c.width_ratio ? Math.round(c.width_ratio * 100) : null, els });
    }
    if (!ok || cols.some(c => c.els.length === 0)) continue;

    const group = doc.createElement("div");
    group.setAttribute("data-cols", "");
    for (const c of cols) {
      const col = doc.createElement("div");
      col.setAttribute("data-col", "");
      if (c.ratio) col.setAttribute("data-ratio", String(c.ratio));
      for (const el of c.els) col.appendChild(el);
      group.appendChild(col);
    }
    marker.replaceWith(group);
  }
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
