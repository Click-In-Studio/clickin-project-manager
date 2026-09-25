// remark 侧的 CJK 侧翼规则（#674）：`甲**乙**丙`、`甲**~~乙~~**丙` 这类两侧紧贴
// 中文的加粗 / 删除线，按 CommonMark 原规则不算定界符。编辑器侧 markdown-it
// 挂了 markdown-it-cjk-friendly（lib/editor/tiptap-cjk-markdown.ts），只读渲染、
// 保真锁、通知文档解析这几处 remark 必须挂同一套，否则两侧解析结果不一致，
// 保真锁会误报或漏报。
//
// 两个包缺一不可：remark-cjk-friendly 只管 `*` / `**`，`~~` 归 gfm-strikethrough
// 那个包；都要排在 remarkGfm 之后。只取 parseOnly 入口——本仓不用 remark-stringify。
// 零 node 依赖，可进客户端包。
import remarkCjkFriendly from "remark-cjk-friendly/parseOnly";
import remarkCjkFriendlyGfmStrikethrough from "remark-cjk-friendly-gfm-strikethrough/parseOnly";

/** 展开进 remarkPlugins / unified().use 链，位置在 remarkGfm 之后 */
export const REMARK_CJK_PLUGINS = [remarkCjkFriendly, remarkCjkFriendlyGfmStrikethrough] as const;
