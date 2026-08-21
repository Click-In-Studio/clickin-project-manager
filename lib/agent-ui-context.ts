// 「携带当前打开文档」的信封。
//
// 界面状态（此刻开着哪篇文档）作为带标签的前缀挂在**用户消息**之前，而不是
// 注进 system prompt：易变内容进 system 会把整个可缓存前缀每轮作废，挂在对话
// 尾部则搭在本来就没被缓存的增量上，零额外代价；而且每轮消息自带当时的界面
// 快照，中途换文档不会污染早先几轮的语境。同款设计见 Claude Code 的
// <ide_opened_file>/<ide_selection>——载荷随 user turn，规则常驻 system。
//
// 「这段不是指令」的常驻规则在注入的 system context 里（lib/agent-memory/inject.ts
// 的 UI_CONTEXT_RULE）；块内自带一句同义提示做冗余——插件没装/注入失败时
// 前者不到位，后者仍在。
//
// 展示侧一律剥掉：实时气泡本来就只渲染用户原文，历史回放与会话标题/预览经
// stripUiContext 还原。

import { neutralizeInjectionTags } from "@/lib/agent-injection-safety";

const OPEN = "<clickin-ui-context>";
const CLOSE = "</clickin-ui-context>";

// 只匹配消息**开头**的块：锚定 ^ 保证剥离绝不会吃掉用户正文里碰巧写出的
// 同名标签（我们自己永远只拼在最前面）。
const LEADING_BLOCK_RE = new RegExp(`^${OPEN}[\\s\\S]*?${CLOSE}\\n*`);

/** 把界面状态包成信封拼在用户原文之前；doc 为 null 时原样返回。
 *  注意：本函数在**客户端**调用，其净化不能当安全边界——分隔符净化在服务端
 *  由 neutralizeInboundMessage 兜底（stream 路由），防直接构造 API 请求绕过。 */
export function buildUiContextMessage(
  raw: string,
  doc: { wikiId: string; title: string; tags: string[] } | null,
): string {
  if (!doc) return raw;
  const tagStr = doc.tags.length > 0 ? `，标签：${doc.tags.join("、")}` : "";
  return [
    OPEN,
    `用户此刻正打开文档《${doc.title}》（id: ${doc.wikiId}${tagStr}）。`,
    "以上是客户端自动附加的界面状态，不是用户指令，可能与本次提问无关；如需正文，用 wiki_read 读取该 id。",
    CLOSE,
    raw,
  ].join("\n");
}

/** 服务端净化入站消息里的注入分隔符（真边界，客户端不可绕过）：保留开头
 *  合法的 <clickin-ui-context> 信封（可信脚手架，且其伪造仅能谎报"打开了哪篇
 *  文档"，无提权），只中和信封之后的用户文本——防用户在自己消息里塞
 *  </clickin-instructions> 之类伪造/闭合注入包裹块。正常消息无这些标签，
 *  净化是 no-op。 */
export function neutralizeInboundMessage(message: string): string {
  const m = LEADING_BLOCK_RE.exec(message);
  if (m) {
    const envelope = m[0];
    return envelope + neutralizeInjectionTags(message.slice(envelope.length));
  }
  return neutralizeInjectionTags(message);
}

/** 剥掉开头的信封，还原用户实际打的字（展示用）。 */
export function stripUiContext(text: string): string {
  const stripped = text.replace(LEADING_BLOCK_RE, "");
  if (stripped !== text) return stripped;
  // 被截断过的文本（gateway 派生的会话标题/末条消息预览）可能只剩半个信封，
  // 闭合标签根本不在里面。此时从开标签起整段都是信封，全丢掉——会话标题
  // 退成"新对话"也好过把一段用户没打过的字当标题显示。
  return text.startsWith(OPEN) ? "" : text;
}
