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

/**
 * 挂在 body 上的横线抑制开关：造栏拖放接管落点时打开，globals.css 里据此
 * 把 `.wiki-dropcursor` 藏起来。
 *
 * 为什么需要这个开关——单靠节点 spec 的 disableDropCursor 不够：
 * prosemirror-dropcursor 的 dragover 在禁用分支里**什么都不做**，既不清除
 * 已经画上的横线也不重新计时（它的 scheduleRemoval 是 5 秒）。于是鼠标只要
 * 在进入造栏区之前扫过普通区域，那条横线就会一直挂着，看起来就是"横线永远
 * 都在"。disableDropCursor 负责不画新的，这个类负责藏掉旧的，两者缺一不可。
 */
export const COLUMN_DROP_ACTIVE_CLASS = "wiki-column-drop-active";
