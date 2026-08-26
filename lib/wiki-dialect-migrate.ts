// wiki 正文方言 v1 → v2 归一化（语法大纲 §2/§3/§5 + §7 迁移方案）。
//
// 一份实现，三处共用：
//   1. 存量迁移（scripts/migrate-wiki-dialect.ts，一次性扫全量 wiki.body）
//   2. 编辑器载入兼容（SmartTextarea markdown 模式；读历史版本/回滚场景）
//   3. 渲染侧兼容（WikiMarkdown 渲染 wiki_revision 历史正文——历史不迁移）
//
// 原先只处理 markdown 上下文（wiki.body），plain 上下文另有一套 [#kind:id] token
// 形态 + 另一个渲染器（SmartText）。「一切文本皆文档」之后两者合一：所有正文都是
// markdown，都走这一个归一化函数——SmartText 与 lib/mention-format 的
// normalizeLegacyMentions 已随之退役。
//
// 幂等：对已是 v2 的正文施加本函数必须原样返回（迁移可重跑，编辑器每次载入都跑）。
import { encodeMentionHref, encodeUserHref, encodeAssetSrc, type ContentMentionAttrs } from "./mention-types";

// 码内的方言是「关于语法的文档」不是真引用——先换占位保护再改写
// （MindWeave protectCodeSpans 同款教训，wiki-db 的边提取也吃过这个亏）
const CODE_SPAN_RE = /(```[\s\S]*?```|`[^`\n]*`)/g;

function protectCode(md: string): { text: string; parts: string[] } {
  const parts: string[] = [];
  // 占位符用 NUL 包裹（WikiMarkdown.preprocessRawWikilinks 同款）：正文里不会
  // 天然出现，不与内容抢匹配。**必须写成 \u0000 转义**——字面 NUL 字节会让
  // git 把源码判成二进制，diff 直接失明（本仓库踩过）。
  const text = md.replace(CODE_SPAN_RE, m => { parts.push(m); return `\u0000C${parts.length - 1}\u0000`; });
  return { text, parts };
}

function restoreCode(text: string, parts: string[]): string {
  return text.replace(/\u0000C(\d+)\u0000/g, (_m, i) => parts[Number(i)] ?? "");
}

/** 旧 href 内层（`<kind>:<id>[?v=..][:aux]`）→ 引用 URI。无法解析则返回 null。 */
function convertLegacyInner(inner: string): string | null {
  const m = inner.match(/^([^:]+):([^:]+)(?::([^:]+))?$/);
  if (!m) return null;
  const [, kindStr, idWithVer, aux] = m;
  const kind = kindStr.startsWith("block.") ? "block" : kindStr;
  const displayMode = kindStr.startsWith("block.") ? kindStr.slice(6) : null;
  const vm = idWithVer.match(/^(.+)\?v=(.+)$/);
  const attrs: ContentMentionAttrs = {
    kind: kind as ContentMentionAttrs["kind"],
    displayMode: displayMode as ContentMentionAttrs["displayMode"],
    id: vm ? vm[1] : idWithVer,
    aux: aux ?? null,
    versionId: vm ? vm[2] : null,
  };
  if (!attrs.id) return null;
  return encodeMentionHref(attrs);
}

/**
 * v1 → v2 归一化。改写清单（语法大纲 §2.4 / §3.5 / §5.2 的迁移映射表）：
 *
 *   ① 转义损坏形态           \[…\]\(…\)            → 去转义
 *   ② @提及 三种旧形态        @[名](uid:x)          → [@名](/__cm__/user/x)
 *                            [@名](uid:x)
 *   ③ 图片                   ![alt](/__cm__asset:id) → ![alt](/__cm__/asset/id)
 *   ④ 引用链接               [#label](/__cm__k:id)  → [#](/__cm__/k/id?…)
 *   ⑤ 废弃裸 token           [#wiki:uuid]           → [#](/__cm__/wiki/uuid)
 *   ⑥ callout 管道参数        > [!💡|#fff]           → > [!💡 bg=#fff]
 *
 * ④ 的显示位一律塌成哨兵 `#`：原先非 wiki 的 kind 会把编辑期 label 写进正文，
 * 目标改名后就冻在那儿（语法大纲 G4）。哨兵不携带信息、永不过期，且在不认
 * 方言的渲染器里仍可见（G5 降级可读）——所以不是留空 `[]`。
 */
export function normalizeWikiDialect(md: string): string {
  const { text, parts } = protectCode(md);
  let t = text;

  // ① 转义损坏（旧 roundtrip bug 产物）——先去转义，后续规则才认得出形态。
  //    只认两种已知的损坏形态，不做通用去转义：正文里合法的 \[ \] 是用户想要的
  //    字面方括号，通用规则会把它们一起吃掉。
  t = t.replace(/\\*\[(#[^\\\]\n]+)\\*\]\\*\((\/__cm__[^)\s\\]+)\\*\)/g, "[$1]($2)");
  t = t.replace(/@\\*\[([^\\\]\n]+)\\*\]\\*\((uid:[^)\s\\]+)\\*\)/g, "@[$1]($2)");

  // ② @提及 → 引用 URI（user）。旧 `uid:` scheme 会被 react-markdown 的
  //    defaultUrlTransform 剥成空串，是线上 @提及渲染失效的根因。
  t = t.replace(/@\[([^\]\n]+)\]\(uid:([^)\s]+)\)/g, (_m, label, id) => `[@${label}](${encodeUserHref(id)})`);
  t = t.replace(/\[@([^\]\n]+)\]\(uid:([^)\s]+)\)/g, (_m, label, id) => `[@${label}](${encodeUserHref(id)})`);

  // ③ 图片（先于 ④——两者 href 前缀相同，但图片带 `!` 且要保住 alt）
  t = t.replace(/!\[([^\]\n]*)\]\(\/__cm__asset:([^)\s]+)\)/g,
    (_m, alt, rest) => `![${alt}](${encodeAssetSrc(rest.split(/[?:]/)[0])})`);

  // ④ 引用链接：显示位塌成哨兵 `#`
  t = t.replace(/\[([^\]\n]*)\]\(\/__cm__([^)\s/][^)\s]*)\)/g, (m0, _label, inner) => {
    const href = convertLegacyInner(inner);
    return href ? `[#](${href})` : m0; // 解析不出来就原样留着，绝不吃内容
  });

  // ⑤ 废弃裸 token（W1 时期形态，从未被渲染成真链接）
  t = t.replace(/\[#wiki:([0-9a-fA-F-]{36})\]/g,
    (_m, id) => `[#](${encodeMentionHref({ kind: "wiki", displayMode: null, id: id.toLowerCase(), aux: null, versionId: null })})`);

  // ⑥ callout 管道参数 → k=v（只认行首 `>` 引用块里的 marker，避免误伤正文方括号）
  t = t.replace(/^((?:[ \t]*>)+[ \t]*)\[!([^\]\n|]*)\|(#[0-9a-fA-F]{3,8})\]/gm,
    (_m, prefix, emoji, color) => `${prefix}[!${emoji} bg=${color}]`);

  return restoreCode(t, parts);
}

/** 正文是否仍含 v1 形态（迁移覆盖率断言 / 巡检用）。 */
export function hasLegacyDialect(md: string): boolean {
  return normalizeWikiDialect(md) !== md;
}
