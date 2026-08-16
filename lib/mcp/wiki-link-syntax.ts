// 零依赖：纯字符串常量，server.ts 静态 import 也不会把 wiki-tools.ts 的
// DB 依赖树拉进 MCP 模块的静态依赖图（本仓库有过 Turbopack 循环依赖 TDZ
// 前科，参见 lib/mcp/server.ts 里其他 loopback 路由的同款注释）。

// 教会模型别瞎发明语法：文档间链接只认行内 token [#wiki:<uuid>]，[[标题]]
// 只是人类手写时的兜底渲染，不会被记入 wiki_link 边表。
export const WIKI_LINK_SYNTAX_NOTE =
  "文档正文是 Markdown（支持 GFM）。链接到另一篇文档时，在正文里写行内 token " +
  "[#wiki:<uuid>]（uuid 从 wiki_tree/wiki_search/wiki_backlinks 的结果获取）——" +
  "不要使用 [[标题]] 形式，那只是给人看的兜底渲染，不会被记为真实的反向链接。";
