// 正文方言校验 + [[标题]] 反解（#333 T2 / P1）。
//
// 为什么需要反解而不是一律拒绝：wiki_read 给模型看的正文里，id 链接被换成
// [[标题]] 显示形态（lib/agent/tools/wiki-tools.ts resolveBodyLinksForDisplay），而
// 方言说明教模型改写时「原样留着」——模型手里根本没有原始 id 形态，写回的
// [[标题]] 若直接落库，链接边（wiki_entity_link 走 extractMentionEdges，只认
// id 形态）就被打断。所以写回路径必须把**无歧义**的 [[标题]] 反解回
// [#](/__cm__/wiki/<id>)，只有歧义（同名多篇）或未知（模型新造）才拒绝。
//
// 纯函数、零 DB 依赖：标题→id 的映射由调用方（lib/agent/tools/wiki-proposal-prepare.ts 的
// /wiki-proposal 端点）查库后传入，本模块可单测。
//
// 代码块安全：code fence / 行内码里的语法示例是"关于语法的文档"不是真引用
// （与 lib/wiki/links.ts extractMentionEdges 同款纪律），反解与校验都跳过。

import { parseCanonicalOpenTag, TEXT_BG_COLORS, TEXT_FG_COLORS } from "../../editor/inline-style-dialect";
import { CONTENT_MENTION_KINDS } from "../../editor/mention-types";

// 与 lib/wiki/links.ts CODE_SPAN_RE 同构（单捕获组 → split 后奇数下标是代码段）
const CODE_SPAN_RE = /(```[\s\S]*?```|`[^`\n]*`)/g;

/** 显示形态 [[标题]]。标题里不含方括号与换行（显示转换生成的形态即如此）。 */
const DISPLAY_LINK_RE = /\[\[([^[\]\n]+)\]\]/g;

/** 死链接的显示占位（resolveBodyLinksForDisplay 对已删目标的输出）。显示转换
 *  丢失了原始 id，反解无从恢复——原样放行为字面文本，不算违规也不反解。 */
export const DEAD_LINK_LITERAL = "已删除的文档";

/** 引用 URI 的 type 位：`](/__cm__/<type>/`。type 只认 CONTENT_MENTION_KINDS + user——
 *  模型自造的 `/__cm__/todo/…` 一类既不落边也解析不出，与其静默变成死 chip，不如
 *  在写回时就报清楚（#670 加 task kind 时补的护栏）。 */
const CM_TYPE_RE = /\]\(\/__cm__\/([a-z]+)\//g;
const KNOWN_REFERENCE_TYPES = new Set<string>([...CONTENT_MENTION_KINDS, "user"]);

/** 旧式裸 token（W1 废弃）：[#wiki:<uuid>] */
const LEGACY_TOKEN_RE = /\[#wiki:[0-9a-fA-F-]{36}\]/;
/** 旧式冒号 href（v1 废弃）：](/__cm__wiki:<id>) 一族 */
const LEGACY_COLON_RE = /\]\(\/__cm__[a-z_.]+:/;

/** 行内样式方言（#524）：正文里出现的 <span …> / <font …> 一律要过 canonical 校验。
 *  <span> 在本库只有一个用途（字色 / 底色），所以拼法不是 canonical 的就是错的，
 *  不猜、不归一化——模型手里有说明书，写对是零成本。 */
const SPAN_OR_FONT_OPEN_RE = /<(span|font)\b[^>]*>/gi;

/** 样式标签流（开 / 闭），供嵌套顺序与配对检查。只认三种 canonical 开标签与两种闭标签；
 *  别的 HTML 不在本检查范围（拼法错的 span 已由上面那条单独报）。 */
const STYLE_TAG_RE = /<span style="[^"]*">|<\/span>|<u>|<\/u>/g;

/** canonical 嵌套顺序（外 → 内）：底色 > 字色 > 下划线。与编辑器 mark priority 同源
 *  （lib/editor/tiptap-inline-style INLINE_STYLE_PRIORITY），这里只查文本层的相对顺序。 */
const STYLE_RANK = { bg: 3, fg: 2, u: 1 } as const;

/**
 * 嵌套顺序 + 配对检查。顺序反了（`<u><span style="color:red">`）、同类套同类、交叉闭合、
 * 未闭合 / 多余闭合都报。为什么在文本层就拦而不是交给编辑器往返：编辑器会按 mark 次序
 * 静默重排，落库形态与模型提交的不同，保真锁会为一件本可提前说清的事响一次。
 */
function checkStyleNesting(text: string): string | null {
  const stack: (keyof typeof STYLE_RANK)[] = [];
  for (const m of text.matchAll(STYLE_TAG_RE)) {
    const tag = m[0];
    if (tag === "</span>" || tag === "</u>") {
      const top = stack.pop();
      if (!top) return `多出的闭标签 ${tag}`;
      const expect = top === "u" ? "</u>" : "</span>";
      if (tag !== expect) return `标签交叉闭合：${top === "u" ? "<u>" : "<span>"} 内先遇到 ${tag}`;
      continue;
    }
    const open = parseCanonicalOpenTag(tag);
    if (!open) continue; // 拼法错的由 SPAN_OR_FONT_OPEN_RE 那条报，这里不重复
    const rank = STYLE_RANK[open.kind];
    for (const outer of stack) {
      if (STYLE_RANK[outer] === rank) return `同类样式套同类（${tag} 套在同类标签里）——换颜色请先闭合外层`;
      if (STYLE_RANK[outer] < rank) return `嵌套顺序反了：${tag} 不能套在 ${outer === "u" ? "<u>" : "字色"} 里面`;
    }
    stack.push(open.kind);
  }
  if (stack.length > 0) return `有 ${stack.length} 个样式标签没有闭合`;
  return null;
}

/** 行尾块锚点 ^xxxx（系统发放；当前"预留解析、不发放"——lib/editor/mention-types.ts，
 *  本检查对存量正文恒通过，为未来发放护航）。 */
const BLOCK_ANCHOR_RE = /\^([A-Za-z0-9_-]{2,32})[ \t]*$/gm;

/** 对非代码段应用变换，代码段原样保留。 */
function mapNonCode(body: string, fn: (seg: string) => string): string {
  return body
    .split(CODE_SPAN_RE)
    .map((seg, i) => (i % 2 === 1 ? seg : fn(seg)))
    .join("");
}

function nonCodeText(body: string): string {
  return body
    .split(CODE_SPAN_RE)
    .filter((_seg, i) => i % 2 === 0)
    .join("\n");
}

/** 收集正文（非代码段）里出现的全部 [[标题]]，供调用方查库建映射。 */
export function extractDisplayTitles(body: string): string[] {
  const out = new Set<string>();
  for (const m of nonCodeText(body).matchAll(DISPLAY_LINK_RE)) {
    if (m[1] !== DEAD_LINK_LITERAL) out.add(m[1]);
  }
  return [...out];
}

function extractAnchors(body: string): Set<string> {
  const out = new Set<string>();
  for (const m of nonCodeText(body).matchAll(BLOCK_ANCHOR_RE)) out.add(m[1]);
  return out;
}

export type DialectCheckResult =
  | { ok: true; body: string; restoredCount: number }
  | { ok: false; problems: string[] };

/**
 * 反解 + 校验一体（顺序：先反解，再对残留形态判违规）。
 *
 * @param body     模型提交的正文
 * @param titleIds 标题 → 该 production 下同名文档 id 列表（调用方查库）
 * @param oldBody  update 时的现行正文（锚点消失检查用）；create 传 null
 */
export function restoreAndCheckBody(
  body: string,
  titleIds: Map<string, string[]>,
  oldBody?: string | null,
): DialectCheckResult {
  const problems: string[] = [];
  let restoredCount = 0;

  const restored = mapNonCode(body, (seg) =>
    seg.replace(DISPLAY_LINK_RE, (raw, title: string) => {
      if (title === DEAD_LINK_LITERAL) return raw; // 死链占位：原样放行（见常量注释）
      const ids = titleIds.get(title) ?? [];
      if (ids.length === 1) {
        restoredCount++;
        return `[#](/__cm__/wiki/${ids[0]})`;
      }
      problems.push(
        ids.length === 0
          ? `[[${title}]]：本库没有这个标题的文档。链接其他文档必须用 [#](/__cm__/wiki/<uuid>) 形态，uuid 从 wiki_tree/wiki_search 结果里取；不确定目标就先搜索，不要凭标题猜。`
          : `[[${title}]]：本库有 ${ids.length} 篇同名文档，按标题无法确定指向。请改用 [#](/__cm__/wiki/<uuid>) 形态点名其中一篇（候选 id：${ids.join("、")}）。`,
      );
      return raw;
    }),
  );

  const scannable = nonCodeText(restored);
  if (LEGACY_TOKEN_RE.test(scannable)) {
    problems.push("正文含已退役的裸 token 形态 [#wiki:<uuid>]，请改用 [#](/__cm__/wiki/<uuid>)。");
  }
  if (LEGACY_COLON_RE.test(scannable)) {
    problems.push("正文含已退役的冒号形态 /__cm__<类型>:<id>，请改用 /__cm__/<类型>/<id>。");
  }
  const unknownTypes = [...new Set(
    [...scannable.matchAll(CM_TYPE_RE)].map((m) => m[1]).filter((t) => !KNOWN_REFERENCE_TYPES.has(t)),
  )];
  if (unknownTypes.length > 0) {
    problems.push(
      `正文含未知的引用类型 /__cm__/${unknownTypes.join("、/__cm__/")}/。` +
      `引用类型只有 ${[...KNOWN_REFERENCE_TYPES].join(" / ")}，不要自造。`,
    );
  }
  const badTags = [...scannable.matchAll(SPAN_OR_FONT_OPEN_RE)]
    .map((m) => m[0])
    .filter((tag) => !parseCanonicalOpenTag(tag));
  if (badTags.length > 0) {
    problems.push(
      `正文含不合规的行内样式标签 ${[...new Set(badTags)].slice(0, 3).join("、")}。` +
      `字色只能写 <span style="color:<色名>"> 一种拼法（色名 ${TEXT_FG_COLORS.join("/")}），` +
      `底色只能写 <span style="background-color:<色名>">（色名 ${TEXT_BG_COLORS.join("/")}），` +
      "字色与底色同时要就两层嵌套、底色在外；不接受 hex / rgb / <font> / 其他 style 属性；恢复默认颜色就去掉标签。",
    );
  }
  const nesting = checkStyleNesting(scannable);
  if (nesting) {
    problems.push(
      `行内样式标签嵌套不合规：${nesting}。固定顺序由外到内是 <span style="background-color:…"> > <span style="color:…"> > <u>，` +
      "每个开标签要有对应闭标签且不交叉；加粗 / 斜体 / 删除线写在最里面。",
    );
  }

  if (oldBody) {
    const oldAnchors = extractAnchors(oldBody);
    if (oldAnchors.size > 0) {
      const newAnchors = extractAnchors(restored);
      const lost = [...oldAnchors].filter((a) => !newAnchors.has(a));
      if (lost.length > 0) {
        problems.push(
          `改写丢失了 ${lost.length} 个系统块锚点（^${lost.join("、^")}）。锚点是评论/块引用的挂载点，由系统发放，改写正文时必须原样保留在对应行尾。`,
        );
      }
    }
  }

  return problems.length > 0 ? { ok: false, problems } : { ok: true, body: restored, restoredCount };
}
