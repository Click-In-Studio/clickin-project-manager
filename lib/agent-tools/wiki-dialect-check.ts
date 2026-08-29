// 正文方言校验 + [[标题]] 反解（#333 T2 / P1）。
//
// 为什么需要反解而不是一律拒绝：wiki_read 给模型看的正文里，id 链接被换成
// [[标题]] 显示形态（lib/agent-tools/wiki-tools.ts resolveBodyLinksForDisplay），而
// 方言说明教模型改写时「原样留着」——模型手里根本没有原始 id 形态，写回的
// [[标题]] 若直接落库，链接边（wiki_entity_link 走 extractMentionEdges，只认
// id 形态）就被打断。所以写回路径必须把**无歧义**的 [[标题]] 反解回
// [#](/__cm__/wiki/<id>)，只有歧义（同名多篇）或未知（模型新造）才拒绝。
//
// 纯函数、零 DB 依赖：标题→id 的映射由调用方（lib/agent-tools/wiki-proposal-prepare.ts 的
// /wiki-proposal 端点）查库后传入，本模块可单测。
//
// 代码块安全：code fence / 行内码里的语法示例是"关于语法的文档"不是真引用
// （与 lib/wiki-db.ts extractMentionEdges 同款纪律），反解与校验都跳过。

// 与 lib/wiki-db.ts CODE_SPAN_RE 同构（单捕获组 → split 后奇数下标是代码段）
const CODE_SPAN_RE = /(```[\s\S]*?```|`[^`\n]*`)/g;

/** 显示形态 [[标题]]。标题里不含方括号与换行（显示转换生成的形态即如此）。 */
const DISPLAY_LINK_RE = /\[\[([^[\]\n]+)\]\]/g;

/** 死链接的显示占位（resolveBodyLinksForDisplay 对已删目标的输出）。显示转换
 *  丢失了原始 id，反解无从恢复——原样放行为字面文本，不算违规也不反解。 */
export const DEAD_LINK_LITERAL = "已删除的文档";

/** 旧式裸 token（W1 废弃）：[#wiki:<uuid>] */
const LEGACY_TOKEN_RE = /\[#wiki:[0-9a-fA-F-]{36}\]/;
/** 旧式冒号 href（v1 废弃）：](/__cm__wiki:<id>) 一族 */
const LEGACY_COLON_RE = /\]\(\/__cm__[a-z_.]+:/;

/** 行尾块锚点 ^xxxx（系统发放；当前"预留解析、不发放"——lib/mention-types.ts，
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
