/**
 * 剧本方言：AI 连续读写剧本正文的文本形态。
 *
 * 设计要点（P0 定谳，2026-08-31）：
 * - **id 往返协议，不做模糊对齐**。block_id 是锚点资产（cue 漂移处理、block_tag、
 *   page_map 都按逻辑 block_id 键），最小 diff 靠「序列化时带 id、改写时保留 id」
 *   实现，而不是 LCS/相似度猜测——猜错一次就是 cue 锚点静默断裂。
 * - **标记（marker）只读**。章节/场次/排练标记以 [m:<id>] 锚点形式出现在方言里，
 *   必须原样保留、不得增删或调换顺序；结构调整走构作工具（scene_propose_* 族），
 *   方言解析器完全不碰 lib/script-marker-domain.ts 的 marker 不变量。
 * - **确定性文法，零猜测**。块类型由显式标记决定（[台]/[白]/[歌]），无标记行必须
 *   有「说话人：」前缀且说话人可解析为已存在角色，否则报错——错误信息本身在教
 *   模型正确写法。
 * - 解析产物经 diffState（lib/script-ops.ts）算最小 patch，落库走 applyPatchToDB
 *   （CoW / advisory lock / cue 漂移 / page_map 全部继承），本模块只做纯函数变换。
 *
 * 三落点同批纪律（同 wiki 方言，见 lib/agent-tools/wiki-link-syntax.ts）：
 * 序列化器（读工具输出）、解析器（写工具输入）、SCRIPT_DIALECT_NOTE（AI 说明书）
 * 在本文件同批维护——文法变，三者必须同批变。
 *
 * 文法（一行 = 一个结构单元）：
 *   [m:<id>] ## 1-2 场名          标记锚点（只读；# 数量=层级，其后文字仅供阅读）
 *   [b:<id>] 张三（低声）、李四：台词   既有对白块；说话人「、」分隔，括注在名后（）内
 *   [b:<id>] [台] 灯光渐暗。       舞台提示块
 *   [b:<id>] [白] 画外音内容        无说话人台词
 *   [b:<id>] [歌] 李四：歌词        歌词（可与说话人组合，或与 [白] 组合）
 *   [b:<id>] [显名] 张三：台词      强制显示角色名
 *   [new] 李四：新增的台词          新块（id 由系统发放）
 *   | 第二行                       正文续行（挂在上一个块上）
 *   [提示] 两人对视                 挂在当前块上的舞台提示（stageComment）
 *   （空行忽略；正文行首与标记撞形时加 \ 转义，如 \[白]……）
 */

import type { Block, BlockType, Character } from "./script-types";
import {
  isMarkerBlock,
  markerBlockRank,
  withLegacyOwnershipProjection,
  withMarkerOwnership,
} from "./script-marker-blocks";

// ── AI 说明书（P2 写工具的 ref 通道 / 读工具的指针都引用这份） ─────────────────

export const SCRIPT_DIALECT_NOTE =
  "剧本方言规则（读到的剧本正文即此形态，改写时必须按此形态输出）：" +
  "①每个正文块首行以头标开始：既有块 [b:<id>]（id 系统发放，必须原样保留，不得改动或伪造），新块 [new]。" +
  "②头标后可跟类型标记：[台]=舞台提示块；[白]=无说话人台词；[歌]=歌词（可与说话人或 [白] 组合）；" +
  "[显名]=强制显示角色名。无类型标记的行必须有「说话人：」前缀——说话人须是已存在的角色名，" +
  "多人用「、」分隔，角色括注写在名字后的（）内，如「张三（哭）、李四：台词」；" +
  "同名或名字含特殊字符（、：（）[]# 等）的角色用 #<角色id> 指代（id 来自 character_list 或读取结果）；" +
  "说话人段里以 \\ 转义的字符只作字面理解（读到的括注内 \\（ \\） 即字面括号，改写时原样保留）。" +
  "③正文跨行时续行以「| 」开头；[提示] 行是挂在当前块上的舞台提示（显示在角色名旁）。" +
  "④[m:<id>] 行是章节/场次/排练标记锚点，只读：必须原样保留，不得新增、删除或调换顺序；" +
  "其后的标题文字仅供阅读，改标题或结构请用 scene_propose_* 工具。" +
  "⑤改写必须输出整段完整内容：输出中省略某个 [b:<id>] 即删除该块；保留 id 即保留该块身份" +
  "（评论/cue/标签都锚定在 id 上——重写内容时务必带原 id，不要删掉再用 [new] 重建）。" +
  "⑥正文行首若与标记撞形（如正文恰以 [白] 开头），在行首加 \\ 转义。" +
  "⑦说话人必须是已存在角色；新角色先用 character_propose_create 创建。空行会被忽略。";

/** 读路径指针（script_read_* 输出尾缀）：正文是方言形态，完整说明按需拉取。 */
export const SCRIPT_DIALECT_POINTER_READ =
  "（正文为剧本方言形态：[b:<id>] 行头携带块 id——引用与改写都以它为锚；[m:] 是只读结构锚点，| 是续行，[提示] 是舞台提示。完整说明用 production.script_dialect_ref 获取。）";

/** 写路径指针（P2 写工具描述用）。硬约束靠模型守规矩只是第一道，真门在解析器校验。 */
export const SCRIPT_DIALECT_POINTER_WRITE =
  "改写剧本正文必须按剧本方言输出：保留序列化文本里的 [b:<id>]/[m:<id>]，新块用 [new]，省略既有 [b:<id>] 即删除。" +
  "方言完整说明若不在当前语境中，必须先调用 production.script_dialect_ref——未获得说明前不得生成改写文本；违反方言的提议会被解析器拒绝。";

// ── 类型 ──────────────────────────────────────────────────────────────────────

export type DialectError = { line: number; message: string };

export type ApplyDialectSummary = {
  /** 新增块的 id（系统发放） */
  inserted: string[];
  /** 内容/属性实际变化的既有块 id */
  updated: string[];
  /** 输出中省略而被删除的既有块 id */
  deleted: string[];
  /** 保留且未变化的既有块数量 */
  retained: number;
};

export type ApplyDialectResult =
  | { ok: true; blocks: Block[]; summary: ApplyDialectSummary }
  | { ok: false; errors: DialectError[] };

type ParsedSpeaker = { charId: string; annotation: string };

type ParsedTextItem = {
  kind: "text";
  line: number;
  /** null = [new] */
  id: string | null;
  stage: boolean;
  bai: boolean;
  lyric: boolean;
  forceShow: boolean;
  speakers: ParsedSpeaker[];
  contentLines: string[];
  stageCommentLines: string[];
};

type ParsedItem = { kind: "marker"; id: string; line: number } | ParsedTextItem;

// ── 序列化：blocks → 方言文本 ─────────────────────────────────────────────────

export type SerializeDialectOptions = {
  /** 标记 id → 生成的场号标签（buildMarkerLabelIndex），仅用于可读性 */
  labelByMarkerId?: ReadonlyMap<string, string>;
};

const LINE_SPLIT_RE = /\r\n|\r|\n/;

/** 正文行首与标记撞形时加一个 \（解析侧剥一个）——只用于头标行的正文起始位。 */
function escapeLeadingBracket(line: string): string {
  return /^\\*\[/.test(line) ? `\\${line}` : line;
}

function unescapeLeadingBracket(line: string): string {
  return /^\\+\[/.test(line) ? line.slice(1) : line;
}

/** 说话人段是变长自由文本嵌进结构位——名字含保留字符时不走字面量，改 #<id> 指代。 */
const SPEAKER_UNSAFE_RE = /[\\、，：:（）()[\]#|\n\r]/;

/** 括注内只需转义括号与反斜杠（顿号/冒号在深度>0 处本就无结构义）；换行折叠成空格。 */
function escapeAnnotation(s: string): string {
  return s.replace(/\r\n|\r|\n/g, " ").replace(/([\\（）()])/g, "\\$1");
}

/** 括注的归一化口径（序列化与合并比较共用，防虚假 update） */
function normAnnotation(s: string | undefined | null): string {
  return (s ?? "").replace(/\r\n|\r|\n/g, " ").trim();
}

function speakerTokens(
  block: Block,
  byId: ReadonlyMap<string, Character>,
  dupNames: ReadonlySet<string>,
): string {
  return block.characterIds
    .map((id) => byId.get(id))
    .filter((c): c is Character => !!c)
    .map((c) => {
      const unsafe = c.name.trim() === "" || c.name !== c.name.trim() || SPEAKER_UNSAFE_RE.test(c.name) || dupNames.has(c.name);
      const base = unsafe ? `#${c.id}` : c.name;
      const ann = normAnnotation(block.characterAnnotations[c.id]);
      return ann ? `${base}（${escapeAnnotation(ann)}）` : base;
    })
    .join("、");
}

export function serializeBlocksToDialect(
  blocks: Block[],
  characters: Character[],
  opts: SerializeDialectOptions = {},
): string {
  const byId = new Map(characters.map((c) => [c.id, c]));
  const nameCount = new Map<string, number>();
  for (const c of characters) nameCount.set(c.name, (nameCount.get(c.name) ?? 0) + 1);
  const dupNames = new Set([...nameCount.entries()].filter(([, n]) => n > 1).map(([name]) => name));
  const lines: string[] = [];

  for (const block of blocks) {
    if (isMarkerBlock(block)) {
      const rank = markerBlockRank(block) ?? 0;
      const label = opts.labelByMarkerId?.get(block.id);
      // 标记标题的真相源是 markerMeta.name（scene_version 派生表读的就是它）；
      // content 只是编辑器同步的镜像，作兜底。标题是展示位（解析侧忽略），
      // 但换行会撕破行结构——折叠成空格
      const title = ((block.markerMeta?.name ?? "").trim() || (block.content ?? "").trim()).replace(/\s+/g, " ");
      let head = `[m:${block.id}] ${"#".repeat(rank + 1)}`;
      if (label) head += ` ${label}`;
      if (title) head += ` ${title}`;
      lines.push(head);
      continue;
    }

    const contentLines = (block.content ?? "").split(LINE_SPLIT_RE);
    const flags: string[] = [];
    let speakers = "";
    if (block.type === "stage") {
      flags.push("[台]");
    } else {
      // 说话人里的悬空角色 id（角色已删但块上残留）序列化时静默跳过；
      // 解析侧的 merge 会把「可解析集合相等」视为未变，保住往返一致性。
      speakers = speakerTokens(block, byId, dupNames);
      if (block.lyric) flags.push("[歌]");
      if (!speakers) flags.push("[白]");
      if (block.forceShowCharacterName) flags.push("[显名]");
    }

    const head = [`[b:${block.id}]`, ...flags].join(" ");
    const first = contentLines[0] ?? "";
    if (speakers) {
      lines.push(`${head} ${speakers}：${first}`);
    } else {
      lines.push(first ? `${head} ${escapeLeadingBracket(first)}` : head);
    }
    for (const l of contentLines.slice(1)) lines.push(l ? `| ${l}` : "|");

    const sc = block.stageComment ?? "";
    if (sc) {
      for (const l of sc.split(LINE_SPLIT_RE)) lines.push(l ? `[提示] ${l}` : "[提示]");
    }
  }

  return lines.join("\n");
}

// ── 解析：方言文本 → 结构化条目 ───────────────────────────────────────────────

// 说话人段的扫描全部是**转义感知**的：`\` 使下一个字符失去结构含义。
// 方言不是定长格式，说话人段（名字/括注）是用户可写文本嵌进结构位——不带转义
// 的朴素 split 会被名字里的 、/：/括号 静默错切（最坏情况切出的前缀恰好是另一个
// 真实角色名，无声错配）。序列化侧对不安全名字走 #<id>，解析侧按本扫描规则读回。

/** 在（）/() 深度为 0 处找第一个未转义冒号（全角优先兼容半角），切出说话人段。 */
function splitSpeakerPayload(payload: string): { speakers: string; content: string } | null {
  let depth = 0;
  for (let i = 0; i < payload.length; i++) {
    const ch = payload[i];
    if (ch === "\\") { i++; continue; }
    if (ch === "（" || ch === "(") depth++;
    else if (ch === "）" || ch === ")") depth = Math.max(0, depth - 1);
    else if ((ch === "：" || ch === ":") && depth === 0) {
      return { speakers: payload.slice(0, i), content: payload.slice(i + 1) };
    }
  }
  return null;
}

/** 按深度 0 处的未转义顿号分名——「张三（甲、乙）」是一个名带括注，不能被切开。 */
function tokenizeSpeakers(segment: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i];
    if (ch === "\\") { i++; continue; }
    if (ch === "（" || ch === "(") depth++;
    else if (ch === "）" || ch === ")") depth = Math.max(0, depth - 1);
    else if (ch === "、" && depth === 0) {
      out.push(segment.slice(start, i));
      start = i + 1;
    }
  }
  out.push(segment.slice(start));
  return out;
}

function unescapeSpeakerText(s: string): string {
  return s.replace(/\\([\s\S])/g, "$1");
}

/** 单个说话人 token → { ref, annotation }。ref 是 `#<id>` 或名字（均已解转义）。 */
function parseSpeakerToken(raw: string): { ref: string; annotation: string } | null {
  const token = raw.trim();
  if (!token) return null;
  // 找第一个未转义的开括号；括注必须收在 token 末尾（且末尾闭括号未被转义），
  // 否则整个 token 当普通名字处理
  let open = -1;
  for (let i = 0; i < token.length; i++) {
    const ch = token[i];
    if (ch === "\\") { i++; continue; }
    if (ch === "（" || ch === "(") { open = i; break; }
  }
  const closeAtEnd = /[）)]$/.test(token) && !/\\[）)]$/.test(token);
  if (open === -1 || !closeAtEnd || open >= token.length - 1) {
    return { ref: unescapeSpeakerText(token), annotation: "" };
  }
  return {
    ref: unescapeSpeakerText(token.slice(0, open).trim()),
    annotation: unescapeSpeakerText(token.slice(open + 1, token.length - 1)).trim(),
  };
}

function parseDialect(
  dialect: string,
  characters: Character[],
): { items: ParsedItem[]; errors: DialectError[] } {
  const items: ParsedItem[] = [];
  const errors: DialectError[] = [];

  // 角色名 → id；同名角色标记为歧义，只有真被用到时才报错（此时指路 #<id> 形态）
  const charByName = new Map<string, { id: string; dup: boolean }>();
  const charById = new Map(characters.map((c) => [c.id, c]));
  for (const c of characters) {
    const existing = charByName.get(c.name);
    if (existing) existing.dup = true;
    else charByName.set(c.name, { id: c.id, dup: false });
  }

  let current: ParsedTextItem | null = null;
  const rawLines = dialect.split(LINE_SPLIT_RE);

  for (let i = 0; i < rawLines.length; i++) {
    const lineNo = i + 1;
    const line = rawLines[i].trimStart();
    if (line.trim() === "") continue;

    // 标记锚点（只读）：id 之后的内容全部忽略
    const marker = /^\[m:([^\]\s]+)\]/.exec(line);
    if (marker) {
      current = null;
      items.push({ kind: "marker", id: marker[1], line: lineNo });
      continue;
    }

    // 续行
    if (line.startsWith("|")) {
      if (!current) {
        errors.push({ line: lineNo, message: "续行（| 开头）之前没有任何块——每个块的首行必须以 [b:<id>] 或 [new] 开头" });
        continue;
      }
      let rest = line.slice(1);
      if (rest.startsWith(" ")) rest = rest.slice(1);
      current.contentLines.push(rest);
      continue;
    }

    // 舞台提示（stageComment）
    const hint = /^\[提示\] ?/.exec(line);
    if (hint) {
      if (!current) {
        errors.push({ line: lineNo, message: "[提示] 行之前没有任何块——它只能挂在一个正文块之后" });
        continue;
      }
      current.stageCommentLines.push(line.slice(hint[0].length));
      continue;
    }

    // 块头标
    const existingHead = /^\[b:([^\]\s]+)\] ?/.exec(line);
    const newHead = existingHead ? null : /^\[new\] ?/.exec(line);
    if (!existingHead && !newHead) {
      current = null;
      if (line.startsWith("#")) {
        errors.push({ line: lineNo, message: "章节/场次结构不能在方言里手写（# 开头的行无效）——结构调整请用 scene_propose_* 工具，标记锚点 [m:<id>] 须原样保留" });
      } else {
        errors.push({ line: lineNo, message: "无法识别的行：块首用 [b:<id>] 或 [new] 开头，正文续行用 | 前缀，空行会被忽略" });
      }
      continue;
    }

    let rest = line.slice((existingHead ?? newHead)![0].length);
    const flags = { stage: false, bai: false, lyric: false, forceShow: false };
    for (;;) {
      const m = /^\[(台|白|歌|显名)\] ?/.exec(rest);
      if (!m) break;
      if (m[1] === "台") flags.stage = true;
      else if (m[1] === "白") flags.bai = true;
      else if (m[1] === "歌") flags.lyric = true;
      else flags.forceShow = true;
      rest = rest.slice(m[0].length);
    }

    if (flags.stage && (flags.bai || flags.lyric || flags.forceShow)) {
      errors.push({ line: lineNo, message: "[台]（舞台提示块）不能与 [白]/[歌]/[显名] 组合" });
      current = null;
      continue;
    }

    const item: ParsedTextItem = {
      kind: "text",
      line: lineNo,
      id: existingHead ? existingHead[1] : null,
      stage: flags.stage,
      bai: flags.bai,
      lyric: flags.lyric,
      forceShow: flags.forceShow,
      speakers: [],
      contentLines: [],
      stageCommentLines: [],
    };

    if (flags.stage || flags.bai) {
      item.contentLines.push(unescapeLeadingBracket(rest));
    } else {
      const split = splitSpeakerPayload(rest);
      if (!split) {
        errors.push({ line: lineNo, message: "缺少「说话人：」前缀——若这一行没有说话人，请加 [白] 标记；舞台提示块请加 [台] 标记" });
        current = null;
        continue;
      }
      const tokens = tokenizeSpeakers(split.speakers).map(parseSpeakerToken);
      if (tokens.length === 0 || tokens.some((t) => t === null)) {
        errors.push({ line: lineNo, message: "说话人为空——没有说话人请用 [白] 标记" });
        current = null;
        continue;
      }
      let bad = false;
      const seen = new Set<string>();
      for (const t of tokens as Array<{ ref: string; annotation: string }>) {
        let charId: string | null = null;
        if (t.ref.startsWith("#")) {
          const id = t.ref.slice(1);
          if (!charById.has(id)) {
            errors.push({ line: lineNo, message: `#${id} 不是已存在的角色 id——# 后必须接 character_list 或读取结果里的角色 id` });
            bad = true;
            continue;
          }
          charId = id;
        } else {
          const found = charByName.get(t.ref);
          if (!found) {
            errors.push({ line: lineNo, message: `说话人「${t.ref}」不是已存在的角色——请核对角色名（含特殊字符的名字可用 #<角色id> 指代），新角色先用 character_propose_create 创建；若这一行没有说话人，请加 [白] 标记` });
            bad = true;
            continue;
          }
          if (found.dup) {
            errors.push({ line: lineNo, message: `角色名「${t.ref}」在本剧中不唯一——请改用 #<角色id> 指代（id 来自 character_list 或读取结果）` });
            bad = true;
            continue;
          }
          charId = found.id;
        }
        if (seen.has(charId)) {
          errors.push({ line: lineNo, message: `说话人「${t.ref}」在同一块中重复` });
          bad = true;
          continue;
        }
        seen.add(charId);
        item.speakers.push({ charId, annotation: t.annotation });
      }
      if (bad) {
        current = null;
        continue;
      }
      item.contentLines.push(split.content);
    }

    items.push(item);
    current = item;
  }

  return { items, errors };
}

// ── 回填：解析条目 + 原块区间 → 新的完整块序列 ────────────────────────────────

function norm(s: string): string {
  return s.replace(/\r\n?/g, "\n");
}

function sameIdArrays(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}

/**
 * 把解析出的值合并回既有块。语义未变时返回**原对象**——diffState 用
 * JSON.stringify 逐块比对，保留原对象引用（含键序）才能得到真正的空 patch。
 */
function mergeRetained(original: Block, p: ParsedTextItem, knownCharIds: ReadonlySet<string>): Block {
  const changes: Partial<Block> = {};

  const content = p.contentLines.join("\n");
  if (norm(original.content ?? "") !== content) changes.content = content;

  const sc = p.stageCommentLines.join("\n");
  if (norm(original.stageComment ?? "") !== sc) changes.stageComment = sc === "" ? null : sc;

  const targetType: BlockType = p.stage ? "stage" : "dialogue";
  if (original.type !== targetType) changes.type = targetType;

  if (p.stage) {
    // 方言不表达舞台提示块的角色/显名/歌词位——这些字段保持原样，避免虚假更新；
    // 对白 → 舞台提示的转换清掉歌词位
    if (original.lyric) changes.lyric = false;
  } else {
    if (original.lyric !== p.lyric) changes.lyric = p.lyric;
    if ((original.forceShowCharacterName ?? false) !== p.forceShow) {
      changes.forceShowCharacterName = p.forceShow;
    }
    const parsedIds = p.speakers.map((s) => s.charId);
    const parsedAnn: Record<string, string> = {};
    for (const s of p.speakers) if (s.annotation) parsedAnn[s.charId] = s.annotation;
    // 与序列化侧对偶：只比「可表达」的部分——悬空角色 id 序列化时被跳过，
    // 这里同样从原值中剔除后再比，相等即视为未变（保留原对象，含悬空 id）
    const resolvableOriginalIds = original.characterIds.filter((id) => knownCharIds.has(id));
    const speakersUnchanged =
      sameIdArrays(resolvableOriginalIds, parsedIds) &&
      // 括注按归一化口径比（序列化时换行折叠、首尾修剪），防虚假 update
      parsedIds.every((id) => normAnnotation(original.characterAnnotations[id]) === (parsedAnn[id] ?? ""));
    if (!speakersUnchanged) {
      changes.characterIds = parsedIds;
      changes.characterAnnotations = parsedAnn;
    }
  }

  return Object.keys(changes).length === 0 ? original : { ...original, ...changes };
}

function buildNewBlock(p: ParsedTextItem, id: string): Block {
  const parsedAnn: Record<string, string> = {};
  for (const s of p.speakers) if (s.annotation) parsedAnn[s.charId] = s.annotation;
  const sc = p.stageCommentLines.join("\n");
  const block: Block = {
    id,
    type: p.stage ? "stage" : "dialogue",
    content: p.contentLines.join("\n"),
    stageComment: sc === "" ? null : sc,
    characterIds: p.stage ? [] : p.speakers.map((s) => s.charId),
    characterAnnotations: p.stage ? {} : parsedAnn,
    lyric: p.stage ? false : p.lyric,
    sceneId: null,
    rehearsalMark: null,
  };
  if (!p.stage && p.forceShow) block.forceShowCharacterName = true;
  return block;
}

export function applyDialectToBlocks(input: {
  /** 完整文档的块序列（marker 归属投影需要全量上下文） */
  allBlocks: Block[];
  /** 被序列化给 AI 的那段连续区间的块 id（按文档顺序） */
  rangeBlockIds: string[];
  dialect: string;
  characters: Character[];
  /** 新块 id 生成器（注入以便测试确定性） */
  newId?: () => string;
}): ApplyDialectResult {
  const { allBlocks, rangeBlockIds, dialect, characters } = input;
  const newId = input.newId ?? (() => crypto.randomUUID());

  if (rangeBlockIds.length === 0) throw new Error("rangeBlockIds 不能为空");
  const start = allBlocks.findIndex((b) => b.id === rangeBlockIds[0]);
  if (start < 0) throw new Error("rangeBlockIds 与 allBlocks 对不上：首个 id 不存在");
  const range = allBlocks.slice(start, start + rangeBlockIds.length);
  if (range.length !== rangeBlockIds.length || !range.every((b, i) => b.id === rangeBlockIds[i])) {
    throw new Error("rangeBlockIds 必须是 allBlocks 中一段完整连续的区间");
  }

  const { items, errors } = parseDialect(dialect, characters);

  // 标记锚点校验：与区间内的标记序列必须一致（不增、不删、不换序）
  const expectedMarkers = range.filter(isMarkerBlock).map((b) => b.id);
  const expectedMarkerSet = new Set(expectedMarkers);
  const gotMarkers: string[] = [];
  for (const item of items) {
    if (item.kind !== "marker") continue;
    if (!expectedMarkerSet.has(item.id)) {
      errors.push({ line: item.line, message: `标记锚点 [m:${item.id}] 不属于本区间——[m:] 行只能原样保留序列化时给出的锚点` });
      continue;
    }
    if (gotMarkers.includes(item.id)) {
      errors.push({ line: item.line, message: `标记锚点 [m:${item.id}] 重复出现` });
      continue;
    }
    gotMarkers.push(item.id);
  }
  const missingMarkers = expectedMarkers.filter((id) => !gotMarkers.includes(id));
  if (missingMarkers.length > 0) {
    errors.push({ line: 0, message: `标记锚点缺失：${missingMarkers.map((id) => `[m:${id}]`).join("、")}——方言不能删除章节/场次/排练标记，结构调整请用 scene_propose_* 工具` });
  } else if (gotMarkers.join(",") !== expectedMarkers.join(",")) {
    errors.push({ line: 0, message: "标记锚点顺序与原文不一致——[m:] 行必须保持原有顺序，场次重排请用构作工具" });
  }

  // 既有块 id 校验：只能引用本区间内的正文块，且不得重复
  const originalTextById = new Map(range.filter((b) => !isMarkerBlock(b)).map((b) => [b.id, b]));
  const seenTextIds = new Set<string>();
  for (const item of items) {
    if (item.kind !== "text" || item.id === null) continue;
    if (!originalTextById.has(item.id)) {
      errors.push({
        line: item.line,
        message: expectedMarkerSet.has(item.id)
          ? `[b:${item.id}] 是标记块的 id——标记请用 [m:${item.id}] 锚点行且保持只读`
          : `[b:${item.id}] 不在本次改写的区间内——id 必须原样取自序列化文本，不得改动或伪造`,
      });
      continue;
    }
    if (seenTextIds.has(item.id)) {
      errors.push({ line: item.line, message: `[b:${item.id}] 重复出现——同一个块 id 只能出现一次` });
      continue;
    }
    seenTextIds.add(item.id);
  }

  if (errors.length > 0) {
    return { ok: false, errors: errors.slice().sort((a, b) => a.line - b.line) };
  }

  // 组装新区间
  const knownCharIds: ReadonlySet<string> = new Set(characters.map((c) => c.id));
  const markerById = new Map(range.filter(isMarkerBlock).map((b) => [b.id, b]));
  const summary: ApplyDialectSummary = { inserted: [], updated: [], deleted: [], retained: 0 };
  const nextRange: Block[] = [];
  for (const item of items) {
    if (item.kind === "marker") {
      nextRange.push(markerById.get(item.id)!);
      continue;
    }
    if (item.id === null) {
      const block = buildNewBlock(item, newId());
      summary.inserted.push(block.id);
      nextRange.push(block);
      continue;
    }
    const original = originalTextById.get(item.id)!;
    const merged = mergeRetained(original, item, knownCharIds);
    // 注：这里只统计字段级变化；纯移动（顺序变化）由 diffState 的 reorder 兜住
    if (merged === original) summary.retained += 1;
    else summary.updated.push(merged.id);
    nextRange.push(merged);
  }
  for (const id of originalTextById.keys()) {
    if (!seenTextIds.has(id)) summary.deleted.push(id);
  }

  const nextAll = [
    ...allBlocks.slice(0, start),
    ...nextRange,
    ...allBlocks.slice(start + range.length),
  ];
  // 归属重算必须跑全量文档：区间前的标记决定区间首块的归属
  const projected = withLegacyOwnershipProjection(withMarkerOwnership(nextAll));
  return { ok: true, blocks: projected, summary };
}
