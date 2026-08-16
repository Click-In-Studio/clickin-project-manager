// 零依赖：纯字符串常量，server.ts 静态 import 也不会把 wiki-tools.ts 的
// DB 依赖树拉进 MCP 模块的静态依赖图（本仓库有过 Turbopack 循环依赖 TDZ
// 前科，参见 lib/mcp/server.ts 里其他 loopback 路由的同款注释）。

// 教会模型别瞎发明语法：文档间链接只认行内 token [#wiki:<uuid>] 或
// [链接文字](/__cm__wiki:<uuid>)，[[标题]] 只是人类手写时的兜底渲染，
// 不会被记入 wiki_link 边表。
//
// 2026-08-16 用户实测抓到的真实故障：模型写出
// "[#wiki:54d43b4a-...]（世界观报告 5.6 节 piece 草案）"——裸 token 后面
// 又跟一段人类可读说明，语义上下相反。根因很可能是旧版提示词里
// "[#wiki:<uuid>]（uuid 从...获取）" 这句说明本身就长得像
// "token 后面跟括号" 的范例，模型依样画瓢学岔了。现版本给出反例明确
// 排除这个写法，不能只靠"正确写法长啥样"这一种正面描述。
export const WIKI_LINK_SYNTAX_NOTE =
  "文档正文是 Markdown（支持 GFM）。链接到另一篇文档用行内 token，裸 token 会在" +
  "渲染/阅读时自动替换成目标文档的真实标题，前后不要再补充任何文字或括号说明——" +
  "例：正确写法 [#wiki:3fa85f64-5717-4562-b3fc-2c963f66afa6]；" +
  "错误写法（不要这样写）[#wiki:3fa85f64-5717-4562-b3fc-2c963f66afa6]（说明文字）。" +
  "如果想要自定义可见的链接文字，用 [自定义文字](/__cm__wiki:3fa85f64-5717-4562-b3fc-2c963f66afa6) 这种 markdown 链接形式，" +
  "而不是在裸 token 后面加括号。uuid 都是从 wiki_tree/wiki_search/wiki_backlinks 的结果里取。" +
  "不要使用 [[标题]] 形式——那只是给人看的兜底渲染，不会被记为真实的反向链接。";
