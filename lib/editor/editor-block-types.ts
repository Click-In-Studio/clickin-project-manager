// 块类型的展示定式 —— **一个 id 一套图标与名字**，插入（`/` 指令）与转换
// （手柄菜单的「转换为」）共用这一张表。
//
// 为什么必须共用：同一个块类型在「新建」里叫「高亮块 💡」、在「转换为」里
// 只写「高亮块」，用户会怀疑这是不是两个东西。图标和名字属于**类型本身**，
// 不属于某个菜单，所以它不该长在任何一个菜单的数据结构里。
//
// 各菜单仍然只放自己那一份差异：`/` 那边是搜索别名与插入命令，转换那边是
// 转换命令。两边的 id 集合也不必相同——
//   · `paragraph` 只出现在转换里（"插入一个段落"没有意义，你本来就在段落里）
//   · `columns` / `table` / `horizontalRule` 只出现在插入里（结构型节点不给转换，
//     见 editor-block-ops 的 UNCONVERTIBLE）

export type BlockTypeMeta = {
  /** 菜单里显示的名字 */
  label: string;
  /** 单字符图标。沿用退役的固定工具栏那套符号——老用户认得 */
  icon: string;
  /** 右侧灰字，说明落成什么形态 */
  hint: string;
};

export const BLOCK_TYPES = {
  paragraph: { label: "正文", icon: "¶", hint: "普通文本" },
  h2: { label: "二级标题", icon: "H2", hint: "## 标题" },
  h3: { label: "三级标题", icon: "H3", hint: "### 标题" },
  bulletList: { label: "无序列表", icon: "≡", hint: "- 条目" },
  orderedList: { label: "有序列表", icon: "1.", hint: "1. 条目" },
  taskList: { label: "任务列表", icon: "☑", hint: "- [ ] 待办" },
  blockquote: { label: "引用", icon: "“", hint: "> 引用" },
  callout: { label: "高亮块", icon: "💡", hint: "> [!💡]" },
  columns: { label: "两栏分栏", icon: "◫", hint: ":::cols" },
  table: { label: "表格", icon: "⊞", hint: "3×3 带表头" },
  codeBlock: { label: "代码块", icon: "{ }", hint: "```" },
  horizontalRule: { label: "分割线", icon: "—", hint: "---" },
} as const satisfies Record<string, BlockTypeMeta>;

export type BlockTypeId = keyof typeof BLOCK_TYPES;
