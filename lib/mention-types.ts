// Shared types and serialization for content mentions (#-prefix)

export type ContentMentionKind = "page" | "scene" | "rehearsal" | "block" | "cue" | "asset" | "wiki";
export type BlockDisplayMode = "page" | "scene" | "rehearsal";

export type ContentMentionAttrs = {
  kind: ContentMentionKind;
  displayMode: BlockDisplayMode | null;
  id: string;
  aux: string | null;
  versionId: string | null;
};

// Returned by the block-search API
export type MentionSearchResult = {
  kind: ContentMentionKind;
  displayMode?: BlockDisplayMode;
  id: string;
  aux?: string;
  versionId?: string; // set when result is from an explicit version-prefix query
  displayLabel: string;
  description?: string;
};

// ── Serialization ──────────────────────────────────────────────────────────────

export function serializeMention(attrs: ContentMentionAttrs): string {
  const kindStr = attrs.kind === "block" && attrs.displayMode
    ? `block.${attrs.displayMode}`
    : attrs.kind;
  const idStr = attrs.versionId ? `${attrs.id}?v=${attrs.versionId}` : attrs.id;
  const auxStr = attrs.aux ? `:${attrs.aux}` : "";
  return `[#${kindStr}:${idStr}${auxStr}]`;
}

// Matches a single DB-format mention token in a larger string
export const MENTION_PATTERN = /\[#[^\]]+\]/g;

export function deserializeMention(token: string): ContentMentionAttrs | null {
  // Format: [#kind:id] or [#kind:id:aux] or [#block.mode:id]
  // The id may have ?v=versionId appended
  const m = token.match(/^\[#([^:]+):([^:\]]+)(?::([^\]]+))?\]$/);
  if (!m) return null;

  const kindStr = m[1];
  const idWithVersion = m[2];
  const aux = m[3] ?? null;

  let kind: ContentMentionKind;
  let displayMode: BlockDisplayMode | null = null;

  if (kindStr.startsWith("block.")) {
    kind = "block";
    displayMode = kindStr.slice(6) as BlockDisplayMode;
  } else {
    kind = kindStr as ContentMentionKind;
  }

  let id = idWithVersion;
  let versionId: string | null = null;
  const vMatch = idWithVersion.match(/^(.+)\?v=(.+)$/);
  if (vMatch) {
    id = vMatch[1];
    versionId = vMatch[2];
  }

  return { kind, displayMode, id, aux, versionId };
}

// ── 引用 URI（markdown 上下文的统一文法，语法大纲 §2）────────────────────────
//
//   /__cm__/<type>/<id>[?k=v&…][#anchor]
//
// 为什么是**路径形态**而不是自定义 scheme（`cm:wiki/…` / 旧的 `uid:…`）：
// react-markdown 的 defaultUrlTransform 只放行 http/https/ircs/mailto/xmpp，
// 其余协议一律剥成空串（实测；见 node_modules/react-markdown/lib/index.js
// 的 defaultUrlTransform + safeProtocol）。`uid:` 旧形态正是栽在这里——href
// 被剥空，WikiMarkdown 里 `h.startsWith("uid:")` 分支永不命中，@提及渲染不成
// chip。路径形态的第一个冒号出现在 `/` 之后，被判为相对 URL，原样放行。
//
// params（开放集合，顺序无关）：
//   as=<block 展示模式>  ← 旧的 `block.<mode>` 点号语法
//   v=<versionId>        ← 版本钉住
//   aux=<挂载点定位>     ← 旧的第三段位置参数 `:aux`
// anchor：块锚点语法位。PR A 只预留解析（认得、不报错、不丢），不发放。
//
// 前缀保持 `/__cm__` 不变：新旧形态都以它开头，渲染器的 startsWith 分派无需
// 双轨；`/cm/` 之类更漂亮的前缀会与真实路由撞车，不采纳。
export const CM_HREF_PREFIX = "/__cm__";

const CM_HREF_RE =
  /^\/__cm__\/([a-z]+)\/([^/?#\s]+)(?:\?([^#\s]*))?(?:#([^\s]*))?$/;

/** 引用 URI 的 type 位。`user` 只走 href 形态（atMention 节点），不入
 *  ContentMentionKind——plain 上下文的 [#kind:id] token 里没有它。 */
export type ReferenceType = ContentMentionKind | "user";

export function encodeMentionHref(attrs: ContentMentionAttrs): string {
  const params = new URLSearchParams();
  // 顺序固定 as → v → aux，保证 canonical（serializer 幂等，保真锁才不会误报）
  if (attrs.kind === "block" && attrs.displayMode) params.set("as", attrs.displayMode);
  if (attrs.versionId) params.set("v", attrs.versionId);
  if (attrs.aux) params.set("aux", attrs.aux);
  const q = params.toString();
  return `${CM_HREF_PREFIX}/${attrs.kind}/${attrs.id}${q ? `?${q}` : ""}`;
}

/** @提及的 href（type=user）。姓名解析端点尚不存在，label 仍留在链接文字里
 *  兜底——见 encodeUserHref 调用处的说明。 */
export function encodeUserHref(userId: string): string {
  return `${CM_HREF_PREFIX}/user/${userId}`;
}

/** 解析引用 URI。新形态优先；旧形态（`/__cm__<kind>:<id>[?v=][:aux]`）保留
 *  只读兼容——wiki_revision 的历史正文不迁移，读历史版本时仍会遇到。 */
export function decodeMentionHref(href: string): ContentMentionAttrs | null {
  if (!href.startsWith(CM_HREF_PREFIX)) return null;

  const m = href.match(CM_HREF_RE);
  if (m) {
    const [, type, id, query] = m;
    if (type === "user") return null; // 走 atMention 分支，不是 contentMention
    const p = new URLSearchParams(query ?? "");
    const as = p.get("as");
    return {
      kind: type as ContentMentionKind,
      displayMode: type === "block" && as ? (as as BlockDisplayMode) : null,
      id: decodeURIComponent(id),
      aux: p.get("aux"),
      versionId: p.get("v"),
    };
  }

  // 旧形态：内层与 DB token 同构，复用 deserializeMention
  return deserializeMention(`[#${href.slice(CM_HREF_PREFIX.length)}]`);
}

/** 图片嵌入的 src（嵌入类 = 引用类 + `!` 前缀，语法大纲 §3）。正文只存 asset
 *  id 不存 URL——URL 是会过期的展示态，id 才是引用。 */
export function encodeAssetSrc(assetId: string): string {
  return `${CM_HREF_PREFIX}/asset/${assetId}`;
}

/** src → assetId。新旧形态双读（旧：/__cm__asset:<id>）；非 asset 引用返回 null。 */
export function decodeAssetSrc(src: string): string | null {
  const m = src.match(CM_HREF_RE);
  if (m) return m[1] === "asset" ? decodeURIComponent(m[2]) : null;
  const legacy = /^\/__cm__asset:([^/?#\s]+)$/.exec(src);
  return legacy ? legacy[1] : null;
}

/** 从引用 URI 取 userId（@提及）。非 user 类型返回 null。 */
export function decodeUserHref(href: string): string | null {
  const m = href.match(CM_HREF_RE);
  if (m && m[1] === "user") return decodeURIComponent(m[2]);
  // 旧形态 uid:<userId>（存量正文 + 历史版本）
  if (href.startsWith("uid:")) return href.slice(4) || null;
  return null;
}

