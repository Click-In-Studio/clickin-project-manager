// 引用 chip 的**显示层**（#689）：类别名、降级态文案、场次 / 剧本片段的标签拼装。
//
// 零 node 依赖，客户端组件与 mention-resolve 路由共用——同一份文案两处渲染
// （编辑态 tiptap renderHTML、只读态 WikiMarkdown），漂了就是同一个 chip 在
// 编辑和阅读两面长得不一样。
//
// 为什么需要这一层：正文里只存 id（`[#](/__cm__/<kind>/<id>)`，语法大纲 G4
// 「显示位是缓存不是真相」），chip 上的字全靠逐观看者解析。解析给不出东西时
// 三个渲染点此前各自落 `?? kind`，于是读者看到的是 `#block` / `#scene` ——
// 内部 kind 名，对导演 / 舞监零信息量。降级文案必须说人话，且必须只写一遍。
import type { ContentMentionKind } from "./mention-types";

/** 读者语言里的类别名。解析不出内容时顶替 kind 名，内部标识符永不出现在界面上。 */
export const MENTION_KIND_LABEL: Record<ContentMentionKind, string> = {
  page: "剧本页",
  scene: "场次",
  rehearsal: "排练记号",
  block: "剧本片段",
  cue: "Cue",
  asset: "资产",
  wiki: "文档",
  task: "任务",
};

/** 服务端在标签位放的哨兵：解析成功、但目标呈现不出来的几种结局。
 *  与标签走同一个字符串通道（不另开字段）——旧正文、通知投影、关联面板都只读
 *  labels[]，加字段等于要所有消费点同批改。 */
export const MENTION_SENTINEL = {
  deleted: "#[已删除]",
  unknownVersion: "#[未知版本]",
  noAccess: "#[无权查看]",
  untitled: "#[无标题]",
} as const;

/** 降级态的后缀与解释。key 与 MENTION_SENTINEL 的值一一对应。 */
const SENTINEL_VIEW: Record<string, { suffix: string; why: (kind: string) => string }> = {
  [MENTION_SENTINEL.deleted]: {
    suffix: "已删除",
    why: (k) => `这条引用指向的${k}已经删掉了`,
  },
  [MENTION_SENTINEL.unknownVersion]: {
    suffix: "无剧本",
    why: (k) => `这个剧组还没有剧本，解析不出这条${k}引用`,
  },
  [MENTION_SENTINEL.noAccess]: {
    suffix: "无权查看",
    why: (k) => `你没有剧本的查看权限，看不到这条引用指向哪个${k}`,
  },
  [MENTION_SENTINEL.untitled]: {
    suffix: "无标题",
    why: (k) => `这条引用指向的${k}还没有标题`,
  },
};

export type MentionChipView = {
  /** chip 上的字 */
  text: string;
  /** 悬浮补充；null = 不挂 title */
  title: string | null;
  /** true = 灰底虚线的降级态，不是可点的活引用 */
  muted: boolean;
};

/** chip 外观。三个渲染点共用同一套底样式，各自再叠 cursor / hover / 下划线。 */
export const MENTION_CHIP_CLASS = {
  ref: "inline-flex items-center px-1 py-0.5 rounded text-[11px] font-mono font-semibold bg-amber-50 text-amber-700 border border-amber-200",
  wiki: "inline-flex items-center px-1 py-0.5 rounded text-[12px] font-medium bg-sky-50 text-sky-700 border border-sky-200",
  muted: "inline-flex items-center px-1 py-0.5 rounded text-[11px] font-mono bg-zinc-50 text-zinc-400 border border-dashed border-zinc-300",
} as const;

/**
 * 把一次解析结果翻成 chip 的显示态。
 *
 * - `label === null` 分两种：请求还没回来（解析中）与已确定失败（`failed`）。
 *   两者都不拿正文里的字顶上——正文里根本没有字，显示位是哨兵。
 * - 哨兵标签走降级态，带类别名 + 原因。
 * - 活标签原样呈现，`#` 前缀补齐（服务端有的分支自带、有的不带）。
 */
export function mentionChipView(
  /** kind 位收 string 而非 ContentMentionKind：`wiki_entity_link` 的 entityType
   *  在库里是裸文本，认不出的值退到「引用」而不是让整个面板炸掉。 */
  kind: string,
  label: string | null,
  detail?: string | null,
  failed?: boolean,
): MentionChipView {
  const kindName = MENTION_KIND_LABEL[kind as ContentMentionKind] ?? "引用";
  if (label === null) {
    return failed
      ? { text: `${kindName}·取不到`, title: `${kindName}标签取不到，刷新页面再试`, muted: true }
      : { text: `${kindName}…`, title: `正在解析这条${kindName}引用`, muted: true };
  }
  const sentinel = SENTINEL_VIEW[label];
  if (sentinel) {
    return { text: `${kindName}·${sentinel.suffix}`, title: sentinel.why(kindName), muted: true };
  }
  const text = label.startsWith("#") ? label : `#${label}`;
  return { text, title: detail ? `${kindName} · ${detail}` : kindName, muted: false };
}

// ── 标签拼装（服务端 mention-resolve 用；放这里是为了与降级文案同文件同测）──

/** 摘要截断上限，按**字数**（CJK 一字算一字）。chip 是行内元素，再长就撑坏段落。 */
const SUMMARY_LIMIT = 10;

/** 正文 → 一行摘要：剥行内 markdown 记号、压空白、按字数截断。 */
export function mentionSummary(content: string, limit = SUMMARY_LIMIT): string {
  const flat = content
    .replace(/[*_]{1,3}/g, "")   // **粗** / __下划线__ 的记号，剥掉只留字
    .replace(/\s+/gu, " ")
    .trim();
  // 按码点切，别按 UTF-16 码元——emoji 与生僻字是代理对，slice 会切出半个字
  const chars = [...flat];
  if (chars.length <= limit) return flat;
  // 切口落在标点上时把标点吃掉：`…说什么，…` 这种「逗号接省略号」读起来是断句失败
  const cut = chars.slice(0, limit).join("").replace(/[\s，。、；：？！,.;:?!]+$/u, "");
  return `${cut}…`;
}

/**
 * 剧本片段 chip 的标签：`#<坐标> <角色>：<摘要>`。
 *
 * 坐标（`0-1-3` / `p.4-2`）保留在可见位而不是只进悬浮：它是剧本 / 导演 / 舞监
 * 之间的通用坐标语，读者会照着它在纸本上翻。摘要是补的那半——光有坐标认不出
 * 是哪一刻，光有摘要又对不上纸本。正文为空（新插入的空块）时只剩坐标。
 */
export function blockMentionLabel(coord: string, content: string, speaker: string | null): string {
  const summary = mentionSummary(content);
  if (!summary) return `#${coord}`;
  return `#${coord} ${speaker ? `${speaker}：` : ""}${summary}`;
}

/** 悬浮里给整句（chip 上那句被截短了）。上限按一条台词的合理长度定，
 *  超长的舞台指示不该把悬浮撑成一屏。 */
const DETAIL_LIMIT = 120;

/** 剧本片段 chip 的悬浮补充：`<角色>：<整句>`。正文为空时没有可补的，给 null。 */
export function blockMentionDetail(content: string, speaker: string | null): string | null {
  const full = mentionSummary(content, DETAIL_LIMIT);
  if (!full) return null;
  return speaker ? `${speaker}：${full}` : full;
}

/** 场次 chip 的标签：`#<场号> <场名>`。没起名就只有场号。 */
export function sceneMentionLabel(num: string, name: string | null): string {
  const clean = (name ?? "").trim();
  return clean ? `#${num} ${clean}` : `#${num}`;
}

/** 文档引用（kind='wiki'）的 chip 文案。它不走 `#` 形态而是 `[[标题]]`，与剧本域的
 *  `#` 引用一眼区分开，所以单列一个分支——编辑态与只读态共用同一份判断。 */
export function wikiChipView(label: string | null, failed?: boolean): MentionChipView {
  if (label === null) {
    return failed
      ? { text: "[[获取失败]]", title: "取不到文档标题，刷新页面再试", muted: true }
      : { text: "[[…]]", title: "正在取文档标题", muted: true };
  }
  if (label === MENTION_SENTINEL.deleted) {
    return { text: "[[已删除的文档]]", title: "这条引用指向的文档已经删掉了", muted: true };
  }
  // 「无标题」是活引用（文档在、只是没起名），其余哨兵一律降级。wiki 不该收到
  // 「无权查看」/「无剧本」（标题级信息恒可解析），兜一手是为了万一收到时也不会
  // 把哨兵字符串原样印成标题。
  if (label !== MENTION_SENTINEL.untitled) {
    const sentinel = SENTINEL_VIEW[label];
    if (sentinel) return { text: `[[${sentinel.suffix}]]`, title: sentinel.why("文档"), muted: true };
  }
  const title = label === MENTION_SENTINEL.untitled ? "无标题文档" : label;
  return { text: `[[${title}]]`, title: "文档引用", muted: false };
}
