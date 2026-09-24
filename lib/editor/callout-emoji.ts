// 高亮块图标选择器的数据与纯逻辑（#525 图标一半）——零 node 依赖，客户端可直接 import。
//
// 参照飞书：点高亮块左上角的表情弹选择器，搜索框 + 分组网格 + 最近使用。
// emoji 是字面字符直接进 markdown（`> [!🔥 bg=…]`），所以这里只是一张给人挑
// 的清单，不是白名单：粘贴 / AI 写进来的任何 emoji 照样渲染。
import { match as pinyinMatch } from "pinyin-pro";

export type CalloutEmojiItem = {
  emoji: string;
  /** 中文名——搜索按它匹配（原文 + 拼音），也做 title */
  name: string;
  /** 英文关键词，给习惯打英文的人 */
  keywords?: string;
};

export type CalloutEmojiGroup = { label: string; items: CalloutEmojiItem[] };

const e = (emoji: string, name: string, keywords?: string): CalloutEmojiItem => ({ emoji, name, keywords });

/** 分组顺序即面板顺序：提示类放最前，剧组常用的舞台物件单独一组 */
export const CALLOUT_EMOJI_GROUPS: readonly CalloutEmojiGroup[] = [
  {
    label: "提示",
    items: [
      e("💡", "灵感", "idea tip"), e("📌", "钉住", "pin"), e("⚠️", "警告", "warning"), e("❗", "重要", "important"),
      e("❓", "疑问", "question"), e("✅", "完成", "done check"), e("❌", "错误", "error wrong"), e("📝", "笔记", "note memo"),
      e("🔥", "紧急", "hot fire urgent"), e("⭐", "星标", "star"), e("🎯", "目标", "target goal"), e("🚀", "上线", "rocket launch"),
      e("📣", "通知", "announce"), e("🔔", "提醒", "bell reminder"), e("💬", "讨论", "comment chat"), e("📎", "附件", "attachment"),
      e("📅", "日程", "calendar date"), e("⏰", "截止", "alarm deadline"), e("🔒", "保密", "lock private"), e("🔗", "链接", "link"),
      e("🧩", "待定", "puzzle tbd"), e("🚧", "施工中", "wip construction"), e("🧪", "试验", "experiment test"), e("🗂️", "归档", "archive"),
    ],
  },
  {
    label: "舞台与制作",
    items: [
      e("🎭", "戏剧", "theatre drama"), e("🎬", "场记板", "clapper action"), e("🎤", "话筒", "mic"), e("🎵", "音乐", "music"),
      e("🎶", "旋律", "notes"), e("🎧", "耳机", "headphone"), e("🔊", "音响", "speaker sound"), e("🎥", "摄像", "camera video"),
      e("📽️", "放映", "projector"), e("🎟️", "门票", "ticket"), e("🎪", "剧场", "circus tent"), e("🩰", "芭蕾", "ballet"),
      e("🎻", "小提琴", "violin"), e("🥁", "鼓", "drum"), e("🎹", "钢琴", "piano"), e("🎺", "小号", "trumpet"),
      e("🎸", "吉他", "guitar"), e("🎨", "美术", "art palette"), e("🖌️", "画笔", "brush"), e("👗", "服装", "costume dress"),
      e("💄", "化妆", "makeup"), e("🔦", "灯光", "flashlight light"), e("🕯️", "烛光", "candle"), e("🪄", "魔术", "magic wand"),
      e("🎞️", "胶片", "film"), e("📷", "照片", "photo"), e("🗓️", "排期", "schedule"), e("📋", "清单", "clipboard list"),
    ],
  },
  {
    label: "表情",
    items: [
      e("😀", "笑", "smile"), e("😂", "笑哭", "joy"), e("🥲", "含泪笑", "smile tear"), e("😊", "微笑", "blush"),
      e("😍", "喜欢", "love eyes"), e("🤔", "思考", "thinking"), e("😅", "尴尬", "sweat"), e("😎", "酷", "cool"),
      e("🥳", "庆祝", "party"), e("😴", "困", "sleep"), e("😢", "哭", "cry"), e("😡", "生气", "angry"),
      e("🤯", "炸裂", "mind blown"), e("🤩", "星星眼", "star struck"), e("😮", "惊讶", "wow"), e("🙄", "翻白眼", "eyeroll"),
      e("🤫", "嘘", "shush quiet"), e("🤝", "合作", "handshake"), e("🙏", "拜托", "please thanks"), e("👀", "围观", "eyes look"),
      e("👍", "赞", "thumbs up"), e("👎", "踩", "thumbs down"), e("👏", "鼓掌", "clap"), e("💪", "加油", "strong"),
      e("✋", "停", "hand stop"), e("👉", "指向", "point right"), e("☝️", "注意", "point up"), e("✍️", "写作", "writing"),
    ],
  },
  {
    label: "物件",
    items: [
      e("📖", "书", "book"), e("📚", "资料", "books"), e("🗒️", "便签", "notepad"), e("📄", "文件", "document"),
      e("📊", "图表", "chart"), e("📈", "上升", "trend up"), e("📉", "下降", "trend down"), e("💰", "预算", "money budget"),
      e("💳", "报销", "card expense"), e("🧾", "票据", "receipt"), e("📦", "物料", "box package"), e("🛠️", "工具", "tools"),
      e("🔧", "维修", "wrench fix"), e("⚙️", "设置", "gear settings"), e("🧰", "工具箱", "toolbox"), e("🪑", "道具", "chair prop"),
      e("🚪", "上下场", "door"), e("🚌", "交通", "bus"), e("🍱", "餐食", "meal bento"), e("☕", "咖啡", "coffee"),
      e("🏠", "住宿", "house"), e("📍", "地点", "location"), e("🗺️", "地图", "map"), e("🧭", "方向", "compass"),
      e("💻", "电脑", "laptop"), e("📱", "手机", "phone"), e("🖨️", "打印", "printer"), e("🔋", "电量", "battery"),
    ],
  },
  {
    label: "符号",
    items: [
      e("✨", "亮点", "sparkles"), e("❤️", "喜爱", "heart"), e("💯", "满分", "hundred"), e("🔴", "红点", "red circle"),
      e("🟠", "橙点", "orange circle"), e("🟡", "黄点", "yellow circle"), e("🟢", "绿点", "green circle"), e("🔵", "蓝点", "blue circle"),
      e("🟣", "紫点", "purple circle"), e("⚫", "黑点", "black circle"), e("▶️", "播放", "play"), e("⏸️", "暂停", "pause"),
      e("⏩", "快进", "fast forward"), e("🔁", "循环", "repeat"), e("➡️", "下一步", "arrow right"), e("⬅️", "上一步", "arrow left"),
      e("🔼", "向上", "up"), e("🔽", "向下", "down"), e("➕", "新增", "plus add"), e("➖", "减少", "minus"),
      e("🆕", "新", "new"), e("🆗", "OK", "ok"), e("🔞", "限制", "restricted"), e("♻️", "复用", "recycle"),
      e("🌟", "闪亮", "glowing star"), e("🌈", "彩虹", "rainbow"), e("☀️", "晴", "sun"), e("🌙", "夜", "moon night"),
    ],
  },
];

const ALL_ITEMS: readonly CalloutEmojiItem[] = CALLOUT_EMOJI_GROUPS.flatMap(g => g.items);

/** 按 emoji 找条目（最近使用列表只存字符，展示时要回查名字） */
export function findCalloutEmoji(emoji: string): CalloutEmojiItem | null {
  return ALL_ITEMS.find(i => i.emoji === emoji) ?? null;
}

/**
 * 搜索：中文名原文 / 拼音（全拼、首字母都行，与 `/` 指令、@提及同一套 pinyin-pro）
 * / 英文关键词。空查询返回 null——面板按分组展示，不是"全部命中"。
 */
export function searchCalloutEmoji(query: string): CalloutEmojiItem[] | null {
  const q = query.trim().toLowerCase();
  if (!q) return null;
  return ALL_ITEMS.filter(i =>
    i.name.includes(q)
    || (i.keywords?.includes(q) ?? false)
    || pinyinMatch(i.name, q) != null,
  );
}

// ── 最近使用（浏览器本地，纯便利，不同步不落库）────────────────────────────
export const RECENT_EMOJI_KEY = "clickin.callout-emoji.recent";
export const RECENT_EMOJI_MAX = 16;

export function readRecentEmoji(): string[] {
  try {
    const raw = globalThis.localStorage?.getItem(RECENT_EMOJI_KEY);
    const list = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(list) ? list.filter((x): x is string => typeof x === "string" && x.length > 0).slice(0, RECENT_EMOJI_MAX) : [];
  } catch {
    return []; // 隐私窗口 / 禁用站点数据：没有"最近"也照常用
  }
}

export function pushRecentEmoji(emoji: string): string[] {
  const next = [emoji, ...readRecentEmoji().filter(x => x !== emoji)].slice(0, RECENT_EMOJI_MAX);
  try { globalThis.localStorage?.setItem(RECENT_EMOJI_KEY, JSON.stringify(next)); } catch { /* 同上 */ }
  return next;
}

// ── 点击命中：图标是 .wiki-callout 的 ::before，伪元素不是事件目标 ───────────
/** 与 globals.css 里 .wiki-callout 的 padding-left / ::before 位置对应：左上 40×40 的角 */
export const CALLOUT_ICON_ZONE = { width: 40, height: 40 } as const;

export function calloutIconHit(rect: Pick<DOMRect, "left" | "top">, clientX: number, clientY: number): boolean {
  return clientX >= rect.left && clientX < rect.left + CALLOUT_ICON_ZONE.width
    && clientY >= rect.top && clientY < rect.top + CALLOUT_ICON_ZONE.height;
}

/** 块菜单「换图标」→ 选择器：在 editor.view.dom 上派发，detail = { pos: callout 节点位置 } */
export const CALLOUT_EMOJI_PICKER_EVENT = "clickin:callout-emoji-picker";
