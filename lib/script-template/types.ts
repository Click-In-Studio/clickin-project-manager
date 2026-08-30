/**
 * 剧本排版模版引擎——数据模型（docs/script-template-engine.md §2）。
 *
 * 模版 = 流模版（每类块怎么排：一个小网格 + 若干内容引用槽）
 *      + 规则（什么时候变样：封闭枚举的条件 → 效果）
 *      + 页模版（页眉页脚页码）。
 * 全是数据：预设是代码常量，演出存「预设 id + 覆盖项」。
 */
import type { Block, BlockType, Scene } from "../script-types";

// ── 文字样式 ─────────────────────────────────────────────────────────────────

/** 字体面记号 → globals.css 的 --font-script / --font-stage / --font-lyric */
export type FaceToken = "script" | "stage" | "lyric";

export type TextStyle = {
  face: FaceToken;
  /** px。估算器按「列宽 / fontSize」算每行容纳的全角单位数 */
  fontSize: number;
  /** px。估算器按「行数 × lineHeight」算高 */
  lineHeight: number;
  weight?: "normal" | "medium" | "bold";
  italic?: boolean;
  underline?: boolean;
  case?: "as-is" | "upper";
  /** CSS letter-spacing */
  letterSpacing?: string;
  color?: string;
  align?: "left" | "center" | "right";
  whiteSpace?: "normal" | "pre-wrap";
};

// ── 流模版：一类块 = 网格 + 槽 ───────────────────────────────────────────────

/** 槽引用的内容字段 */
export type SlotField =
  | "character"      // 角色名（含标注），多角色以「、」连
  | "stageComment"   // 角色名下的括号提示（block.stageComment，逐行加分隔符）
  | "content"        // 正文（markdown-ish，含行内舞台指示）
  | "scene.number"   // 生成的场号（"0-1" 这种章-场）
  | "scene.name"
  | "act.roman"      // 幕（章节标记）序号的罗马数字：I、II…
  | "scene.local";   // 场在本幕内的序号：1、2…

export type ColumnSpec = {
  /** "7.5rem" | "1rem" | "1fr" | "auto"。估算器只认 rem / px / fr；auto 按 max-content 估 */
  width: string;
};

export type Frame = {
  columns: ColumnSpec[];
  /** px，列间距（CSS column-gap） */
  gapX: number;
};

export type Slot = {
  id: string;
  /** 单字段，或多字段按 joiner 拼成一段（legacy-center 把括号提示与正文放同一个 div） */
  field: SlotField | SlotField[];
  joiner?: string;
  /** rowSpan "all" = 侧栏标签，贯穿本块所有行（legacy-compact 的左栏角色名）——不参与行折叠 */
  box: { col: number; row: number; colSpan?: number; rowSpan?: number | "all" };
  /**
   * 行内槽。同一行里若有占格的 content 槽，本槽作为前缀并入其首行（「角色：台词」）；
   * 若同一行全是 inline 槽，它们连成一条文字流（`JOHN (laughing)` 居中一行）。
   */
  inline?: boolean;
  /** px：左右缩进与首行缩进（Samuel French 的「三个缩进」「歌词一个缩进」） */
  indent?: { left?: number; right?: number; firstLine?: number };
  /** 槽只在字段长度落在区间内才出现（短提示跟在角色名同行、长提示另起一行） */
  when?: { maxChars?: number; minChars?: number };
  style: TextStyle;
  /** 装饰：前后缀。stageComment 的括号默认取演出配置的舞台指示分隔符 */
  decorate?: { before?: string; after?: string };
  /** 字段为空 → 连装饰一起隐藏（epic 决策 6 要保留的能力）。content 永不为空（至少一行） */
  hideIfEmpty?: boolean;
  /** 该槽只在块有角色时出现（legacy：无角色的对白块不显示括号提示） */
  requireCharacters?: boolean;
  /** px，槽下外边距（legacy 角色名行 mb-0.5 = 2） */
  marginBottom?: number;
  /** 渲染时把本槽首行与另一槽的末行光学对齐（legacy-compact 的角色名 / 正文对齐） */
  alignFirstLineTo?: string;
  /** px，渲染时整槽下移这么多（legacy-compact 角色名 translateY(1px) 的光学微调） */
  opticalOffsetY?: number;
};

export type BlockStyleId = "dialogue" | "lyric" | "stage" | "sceneHeading";

export type BlockStyle = {
  frame: Frame;
  slots: Slot[];
  /** px，块外沿。规则可改 */
  padding: { top: number; bottom: number };
  /** 渲染装饰：rule-lines = 两侧横线夹着槽（legacy 场次标题） */
  decoration?: "rule-lines";
  /**
   * 估算器专用：算列宽前先从内容宽里扣掉这么多。legacy-compact 的估算器给**所有**块
   * （含通栏渲染的舞台指示）都按「减去左栏」的宽度估行数——渲染没这回事，只是估算的
   * 口径，为存量页码保留。新模版不要用。
   */
  estimateWidthInset?: number;
};

// ── 规则 ─────────────────────────────────────────────────────────────────────

/**
 * 封闭枚举的条件：估算器（无 DOM）、测量层、预览三处都要一致地求值，且将来要画成界面，
 * 表达式语言三处都难。字段全部可选，给了的都要满足（AND）；组合用 not / all / any。
 */
export type Predicate = {
  type?: BlockType;
  lyric?: boolean;
  hasCharacters?: boolean;
  forceShowCharacterName?: boolean;
  hasPrev?: boolean;
  prevType?: BlockType;
  prevHasCharacters?: boolean;
  prevSameCharacters?: boolean;
  prevSameScene?: boolean;
  prevSameRehearsalMark?: boolean;
  isSceneStart?: boolean;
  /** 本页首块（分页器决定；plan 对两种取值各求一次得到两个变体） */
  firstOnPage?: boolean;
  /** 到本条规则为止，某槽是否仍可见（规则按序求值，前面的效果可被后面的条件看到） */
  slotVisible?: string;
  slotHidden?: string;
  not?: Predicate;
  all?: Predicate[];
  any?: Predicate[];
};

export type Effect = {
  hide?: string[];
  show?: string[];
  /** px，块前间距（不是本页首块时才生效；是否计入估算由 template.estimate 决定） */
  gapBefore?: number;
  paddingTop?: number;
  paddingBottom?: number;
  breakBefore?: "page";
  keepWithNext?: boolean;
  /** 给某槽的文字加后缀（「(Cont.)」） */
  suffix?: Record<string, string>;
};

export type Rule = {
  id: string;
  /** 只对这些块样式生效；缺省全部 */
  styles?: BlockStyleId[];
  when: Predicate;
  then: Effect;
};

// ── 页模版（只放页眉页脚页码；页序列 / 杂页 / 首页归 F+G）──────────────────

export type PageBandField = "scene.label" | "page.number" | "act.roman" | "scene.local" | "scene.number" | "production.name";
export type PageBandItem = { field: PageBandField } | { text: string };
export type PageBand = {
  items: PageBandItem[];
  align: "left" | "center" | "right" | "alternate";
  /** alternate 时首页靠哪边 */
  firstPage?: "left" | "right";
  style: TextStyle;
};

export type PageTemplate = {
  header: PageBand;
  footer: PageBand;
  toc: { enabled: boolean };
};

// ── 模版 ─────────────────────────────────────────────────────────────────────

export type EstimateOptions = {
  /** legacy 估算器不计说话人间距（DOM 分页计）；新模版一律 true */
  countGapBefore: boolean;
  /**
   * legacy 估算器给可见角色名固定加 22px，哪怕它在侧栏（compact）不占高。
   * 为了存量演出的页码不在上线那天漂移而保留；新模版留空走真实几何。
   */
  characterSlotHeight?: number;
};

export type ScriptTemplate = {
  id: string;
  name: string;
  version: 1;
  page: PageTemplate;
  blockStyles: Record<BlockStyleId, BlockStyle>;
  rules: Rule[];
  estimate: EstimateOptions;
};

// ── plan 的产物 ───────────────────────────────────────────────────────────────

export type ResolvedSlot = {
  slot: Slot;
  /** 纯文本（估算器用；已含装饰与拼接） */
  text: string;
  /** 渲染源（markdown-ish；content 走 mdToHtml，其余按纯文本） */
  parts: Array<{ field: SlotField; raw: string; before: string; after: string }>;
  empty: boolean;
};

export type Variant = {
  hidden: ReadonlySet<string>;
  paddingTop: number;
  paddingBottom: number;
  suffix: Readonly<Record<string, string>>;
};

export type LayoutItem =
  | {
      kind: "block";
      id: string;
      block: Block;
      styleId: BlockStyleId;
      style: BlockStyle;
      slots: ResolvedSlot[];
      normal: Variant;
      pageTop: Variant;
      gapBefore: number;
      breakBefore: boolean;
      keepWithNext: boolean;
    }
  | {
      kind: "sceneHeading";
      id: string;
      scene: Scene | null;
      sceneId: string;
      style: BlockStyle;
      slots: ResolvedSlot[];
      normal: Variant;
      pageTop: Variant;
      /** 每场另起页（规则 breakBefore 作用在场次标题上） */
      breakBefore: boolean;
    };
