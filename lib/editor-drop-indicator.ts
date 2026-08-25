// 拖拽落点指示线（调研文档 §2.6 ②「落点用 posAtCoords 算插入位置并画一条
// drop indicator 横线」）的配置。
//
// 机制不需要自己造：StarterKit 自带 prosemirror-dropcursor，DragHandle 也确实
// 设了 view.dragging（它只挂 keydown，不抢 dragover）。缺的纯粹是**可见性**——
// 内建默认是 `{ width: 1, color: "currentColor" }`，一根随正文颜色的发丝线，
// 在浅色正文里等于没有，实测就是「拖起来了但不知道会落在哪」。
//
// 选插入线而不是「挤开动画」：ProseMirror 拥有 DOM，dragover 期间给兄弟节点
// 持续施加 transform 会和 view 层抢 DOM 所有权——PM 随时可能因为一个
// transaction 重建那些节点。飞书 / Notion 同样用插入线，正是因为它们的 DOM
// 也只是数据投影（§2.2「HTML 只是渲染副产品」）。挤开动画的前提是列表项由
// 自己完全掌控，在这里不成立。
//
// 抽成常量是为了能被测试锁住：这是个「改回默认值也一切正常、只是看不见了」
// 的配置，没有测试兜着就会在某次清理里被无声还原。

/** prosemirror-dropcursor 的内建默认值 —— 即「看不见」的那一组 */
export const DROP_INDICATOR_DEFAULTS = {
  width: 1,
  color: "currentColor",
  class: undefined as string | undefined,
} as const;

/** 落点指示线：3px + sky-500，形状（圆头/光晕）交给 CSS 类 */
export const DROP_INDICATOR_OPTIONS = {
  width: 3,
  color: "#0ea5e9",
  class: "wiki-dropcursor",
} as const;

// 注：**有块工具的面不用这套内建 dropcursor**，那里由 lib/tiptap-column-drop
// 统一画横线与竖线（两套指示系统并存就得互相抑制，而 dropcursor 的禁用分支
// 不清除已画上的线，抑制不干净）。这份配置只服务于没有块工具的 markdown 面
// ——活动纪要、公告那类小编辑框，它们不需要造栏，一条横线就够了。
