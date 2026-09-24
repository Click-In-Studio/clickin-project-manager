// 任务的零依赖共享类型 / 标签：客户端组件与 API 路由都要用，不能带 pg。

/** 任务状态 → 面上文字。与任务面板 / 任务详情页同一套词。 */
export const TASK_STATUS_LABELS: Record<string, string> = {
  awaiting: "待确认", pending: "待处理", in_progress: "进行中", done: "完成",
};

/** 文档里 task 引用（`[#](/__cm__/task/<id>)`）的实时标签（#670）：标题 + 状态。
 *  mention-resolve、通知投影、编辑器 chip 刷新三处同一个格式——读者在文档里
 *  看到的就是「这件事叫什么、做到哪了」，不用点进去。 */
export function taskMentionLabel(title: string, status: string): string {
  return `${title} · ${TASK_STATUS_LABELS[status] ?? status}`;
}
