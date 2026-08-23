// 注入分隔符净化——防止用户可控内容伪造/提前闭合我们的注入包裹块。
//
// 威胁：个人指令、制作指令、蒸馏记忆、用户档案 bio、用户消息正文等都是用户
// 可控文本，最终会被拼进 <clickin-instructions> / <clickin-memory> /
// <clickin-ui-context> 包裹。若不净化，用户可写入 `</clickin-instructions>`
// 提前闭合自己的低信任块，再伪造一个看起来更高层级的块（如冒充系统级规范）。
// 硬边界「语境不是权限」仍拦得住越权取数（工具权限走服务端判定，不看 prompt），
// 但伪造块能操纵 agent 行为/绕过软规则——制作级指令还会波及全体成员会话。
//
// 修复不依赖"标签名保密"：无论攻击者是否知道标签名，这些分隔符在用户内容里
// 都被中和，无法参与 XML 式解析。

// 匹配我们的包裹分隔符：<clickin-…> 或 </clickin-…>，容忍多余空白与截断
// （缺尾 > 也算，防半截标签配合模型补全）。大小写不敏感。
// 刻意不吞属性（我们的真标签从不带属性）：`<clickin-x foo="y">` 只中和到
// `<clickin-x`，尾部留个裸 `>`——无害，因为没有配对的 `<` 能再组成标签，
// 而伪造所需的 `<clickin-…` 前缀已被中和。不用 [^>]* 贪吃属性，避免误伤
// 文本里无关的 `>`（如 "a > b"）。
const WRAPPER_TAG_RE = /<\s*\/?\s*clickin-[a-z0-9-]*\s*>?/gi;

/**
 * 把用户可控文本里所有 <clickin-…> 式分隔符中和为不可解析形态：**原地**把
 * 尖括号换成全角 ＜＞（不是删除）。原地替换而非删除是关键——删除会让
 * `<clic<clickin-instructions>kin-instructions>` 这类嵌套在移除内层后重组
 * 出真标签；原地换字符无相邻字符融合，重组不成立。全角括号保留可读性
 * （人能看出"这里本来像个标签，已失效"），但绝不会被当作真的块边界。
 */
export function neutralizeInjectionTags(text: string): string {
  return text.replace(WRAPPER_TAG_RE, (m) => m.replace(/</g, "＜").replace(/>/g, "＞"));
}
