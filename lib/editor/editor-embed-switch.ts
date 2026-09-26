// 引用 chip ⇄ 嵌入块互转（#692）。
//
// 语法只有一种：嵌入 = 引用加 `!`（语法大纲 §3）。`[#](/__cm__/asset/<id>)` 是引用
// chip，`![说明](/__cm__/asset/<id>)` 是嵌入块，两者指向同一份素材。所以「转为嵌入」
// 与「转为引用」都不是新方言，只是同一个 id 在两种形态之间搬家——正文里除了
// 加减一个 `!` 什么都不该变。
//
// 为什么做成事后切换而不是拖入时弹面板：飞书粘贴链接后的「显示为」、文件块的
// 「文本 / 卡片 / 预览」，Notion 的 mention ⇄ bookmark 右键互转，都是先落默认形态、
// 形态随时可改。少一次打断，也顺带覆盖了「插进去了才想改」的场景。
//
// 只有 asset 有嵌入形态：wiki / scene / cue 没有对应的渲染方言，转换项对它们
// **灰掉给原因**而不是消失（§13.4 上下文菜单定式）。
//
// 零 node 依赖：客户端组件直接 import；只吃 EditorState，可在 jsdom 上测。
import type { EditorState, Transaction } from "@tiptap/pm/state";
import type { Node as PMNode } from "@tiptap/pm/model";
import { decodeAssetSrc, encodeAssetSrc, type ContentMentionAttrs } from "./mention-types";
import { MENTION_KIND_LABEL } from "./mention-display";
import type { ContentMentionKind } from "./mention-types";

// ── chip 上的菜单项 ───────────────────────────────────────────────────────────

/** 素材有没有嵌入形态——要查一次 preview-url 才知道，所以是四态而不是布尔 */
export type EmbedCheck = "unknown" | "checking" | "yes" | "no" | "failed";

export type ChipMenuItem = {
  id: "open" | "embed";
  label: string;
  /** 有值 = 灰掉，值就是给用户看的原因 */
  disabledReason?: string;
};

/** 各 kind 同一套项、同一顺序；不能做的灰掉给原因，不消失。 */
export function chipMenuItems(kind: string, embed: EmbedCheck): ChipMenuItem[] {
  const kindName = MENTION_KIND_LABEL[kind as ContentMentionKind] ?? "这类引用";
  let embedReason: string | undefined;
  if (kind !== "asset") {
    embedReason = `只有素材能嵌入正文，${kindName}只能引用`;
  } else if (embed === "unknown" || embed === "checking") {
    embedReason = "正在查这份素材能不能嵌入…";
  } else if (embed === "no") {
    embedReason = "这种文件没有嵌入形态（图片、视频、音频才有），只能引用";
  } else if (embed === "failed") {
    embedReason = "查不到这份素材的类型，刷新页面再试";
  }
  return [
    { id: "open", label: "打开" },
    { id: "embed", label: "转为嵌入", disabledReason: embedReason },
  ];
}

// ── 引用 → 嵌入 ──────────────────────────────────────────────────────────────

/** 段落里除了这颗 chip 只有空白：整段可以直接换成图片块 */
function onlyChipIn(paragraph: PMNode): boolean {
  let chips = 0;
  let other = false;
  paragraph.forEach((child) => {
    if (child.type.name === "contentMention") chips += 1;
    else if (!(child.isText && !(child.text ?? "").trim())) other = true;
  });
  return chips === 1 && !other;
}

/**
 * 把 pos 处的 asset 引用 chip 换成嵌入块。返回 null = 这里没有可转的东西
 * （不是 chip、不是 asset、schema 里没有 image 节点、或落点放不下块）。
 *
 * chip 是行内原子，嵌入是块：段落里只有它时整段换掉；夹在文字中间时删掉 chip
 * （连同紧跟的一个空格）、把嵌入块放到这一段**后面**——不把一段话劈成两半。
 */
export function mentionToEmbedTx(state: EditorState, pos: number): Transaction | null {
  const node = state.doc.nodeAt(pos);
  if (!node || node.type.name !== "contentMention") return null;
  const attrs = node.attrs as ContentMentionAttrs & { label: string | null };
  if (attrs.kind !== "asset") return null;
  const imageType = state.schema.nodes.image;
  if (!imageType) return null;
  const image = imageType.create({ src: encodeAssetSrc(attrs.id), alt: attrs.label ?? "" });

  const $pos = state.doc.resolve(pos);
  const depth = $pos.depth;
  if (depth < 1) return null;
  const paragraph = $pos.parent;
  const container = $pos.node(depth - 1);
  const index = $pos.index(depth - 1);
  const tr = state.tr;

  // 整段只有 chip，且容器允许这一位换成块（列表项首段不允许——它的首子必须是段落）
  if (onlyChipIn(paragraph) && container.canReplaceWith(index, index + 1, imageType)) {
    tr.replaceWith($pos.before(depth), $pos.after(depth), image);
    return tr;
  }
  if (!container.canReplaceWith(index + 1, index + 1, imageType)) return null;

  let to = pos + node.nodeSize;
  const next = state.doc.nodeAt(to);
  if (next?.isText && (next.text ?? "").startsWith(" ")) to += 1;
  tr.delete(pos, to);
  tr.insert(tr.mapping.map($pos.after(depth)), image);
  return tr;
}

// ── 嵌入 → 引用 ──────────────────────────────────────────────────────────────

/** 块菜单上「转为引用」灰掉的原因；null = 可以转 */
export function embedToMentionReason(node: PMNode | null): string | null {
  if (!node || node.type.name !== "image") return "只有嵌入的素材能转成引用";
  if (!decodeAssetSrc((node.attrs.src as string | null) ?? "")) {
    return "这张图是外部链接，不在素材库里，没法变成引用";
  }
  return null;
}

/**
 * 把 pos 处的嵌入块换成一段只含引用 chip 的段落。alt 进 chip 的 label 位——
 * 它只是编辑期快照，标签活刷新会用素材的实时名字盖掉。
 */
export function embedToMentionTx(state: EditorState, pos: number): Transaction | null {
  const node = state.doc.nodeAt(pos);
  if (embedToMentionReason(node) || !node) return null;
  const id = decodeAssetSrc(node.attrs.src as string)!;
  const mentionType = state.schema.nodes.contentMention;
  const paragraphType = state.schema.nodes.paragraph;
  if (!mentionType || !paragraphType) return null;
  const alt = ((node.attrs.alt as string | null) ?? "").trim();
  const chip = mentionType.create({
    kind: "asset", displayMode: null, id, aux: null, versionId: null, label: alt || null,
  } satisfies ContentMentionAttrs & { label: string | null });
  // 不补尾空格：整段只有这颗 chip，空格只会序列化成行尾多余的一个字节
  const paragraph = paragraphType.create(null, chip);
  return state.tr.replaceWith(pos, pos + node.nodeSize, paragraph);
}
