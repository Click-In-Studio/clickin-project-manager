// 输入态 → 存储态 归一化（语法大纲 §6.4 拍板项）。
//
// 人类输入是**指令**（`@` / `[[` / `#` 触发 picker，选中即插入存储态），不是一种
// 文档形态——所以正常情况下根本不需要归一化。唯一的例外是**源码模式**：它没有
// 指令 UI（本身又是保真锁触发后的降级模式），人只能手写。
//
// 拍板：只给 `[[标题]]` 一条手写通道。理由——它是唯一一个人能凭记忆写出来的引用
// 形态；`#p.1` 天然无歧义但需要剧本查询，`@张三` 有歧义应当由 picker 消歧。
//
// **不在服务端做**：服务端归一化会顺带让 AI 的 `[[标题]]` 也生效，而 AI 恒写存储态
// 是拍板项（AI 手里本来就有 uuid，按标题指向是把精确降级成模糊再猜回来）。
// 放在源码模式的保存路径上，作用域正好等于"没有指令 UI 的人类输入"。
import { encodeMentionHref } from "../mention-types";

const CODE_SPAN_RE = /(```[\s\S]*?```|`[^`\n]*`)/g;
// 与 WikiMarkdown 的渲染侧同一形态：不含 [ ] | # 换行
const WIKILINK_RE = /\[\[([^[\]\n|#]+)\]\]/g;

/** 正文里手写的 [[标题]] 清单（去重、去空白）。 */
export function collectWikilinkTitles(body: string): string[] {
  const stripped = body.replace(CODE_SPAN_RE, "");
  const out = new Set<string>();
  for (const m of stripped.matchAll(WIKILINK_RE)) {
    const t = m[1].trim();
    if (t) out.add(t);
  }
  return [...out];
}

/**
 * 把能解析的 [[标题]] 升格成存储态引用；解析不中的**原样留着**（幻影语义）。
 *
 * 绝不猜：标题在 titleMap 里缺失就是缺失，不做模糊匹配、不取最接近的一条。
 * 幻影仍会被渲染成虚线 chip，目标文档后来创建了，下次保存自然升格。
 * 码内的 [[...]] 是语法示例，先保护再改写。
 */
export function promoteWikilinks(body: string, titleMap: Map<string, string>): string {
  const parts: string[] = [];
  const text = body.replace(CODE_SPAN_RE, m => { parts.push(m); return `\u0000C${parts.length - 1}\u0000`; });
  const promoted = text.replace(WIKILINK_RE, (raw, title: string) => {
    const id = titleMap.get(title.trim());
    if (!id) return raw; // 幻影：留着
    return `[#](${encodeMentionHref({ kind: "wiki", displayMode: null, id, aux: null, versionId: null })})`;
  });
  return promoted.replace(/\u0000C(\d+)\u0000/g, (_m, i) => parts[Number(i)] ?? "");
}
