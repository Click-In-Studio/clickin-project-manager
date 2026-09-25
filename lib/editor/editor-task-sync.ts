// 文档任务项 ⇄ production 任务（#670）的编辑器侧纯逻辑。组件（components/editor/
// TaskSyncMenu）只管拉选项、发请求、摆位置；「光标在哪个任务项上」「这一行叫什么」
// 「往哪插引用」全在这里，能在真实 schema 上单测。
//
// 存储形态：任务项那一行末尾追加一颗 contentMention(kind="task")，序列化为
// `[#](/__cm__/task/<id>)`——与其他引用同一套方言（落 wiki_entity_link 边、显示位
// 塌成 `#`、标题 / 状态实时 resolve）。#379 曾把关系存成普通站内链接 + 冻结的
// 「打开任务」文字，被驳回的正是这一层。
import type { Editor } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";

export type TaskItemContext = {
  /** taskItem 节点的绝对位置（node 前） */
  pos: number;
  /** 这一行的文字（不含任务引用 chip 与其他 chip）。原样 trim，不剥任何尾巴——
   *  #379 用正则剥 `·` 把正常以 `·` 结尾的标题咬掉一截 */
  title: string;
  /** 已同步的任务 id；未同步为 null */
  taskId: string | null;
};

/** 光标（折叠选区）所在的任务项。不在任务项里 / 选区非空 → null。 */
export function findTaskItemContext(editor: Editor): TaskItemContext | null {
  const { selection } = editor.state;
  if (!selection.empty) return null;
  const { $from } = selection;
  for (let depth = $from.depth; depth >= 1; depth--) {
    const node = $from.node(depth);
    if (node.type.name !== "taskItem") continue;
    const pos = $from.before(depth);
    return { pos, ...summarizeTaskItem(node) };
  }
  return null;
}

/** 只看首段（嵌套子列表是别的任务项）：标题 = 首段里的文字；引用 = 首段里的 task chip。 */
function summarizeTaskItem(item: PMNode): { title: string; taskId: string | null } {
  const paragraph = item.firstChild;
  if (!paragraph) return { title: "", taskId: null };
  let taskId: string | null = null;
  const text: string[] = [];
  paragraph.forEach(child => {
    if (child.type.name === "contentMention") {
      if (child.attrs.kind === "task" && typeof child.attrs.id === "string" && child.attrs.id) taskId ??= child.attrs.id;
      return;
    }
    if (child.type.name === "atMention") { text.push(`@${child.attrs.label ?? ""}`); return; }
    if (child.isText) text.push(child.text ?? "");
  });
  return { title: text.join("").trim(), taskId };
}

/**
 * 在任务项首段末尾写入任务引用。已有引用 → 不重复（返回 false）；位置不是任务项 →
 * false。label 是编辑期快照（chip 立刻有字可显示），随后由 SmartTextarea 的标签刷新
 * 用 mention-resolve 覆盖——正文里落的永远只有 `[#](/__cm__/task/<id>)`。
 */
export function insertTaskMention(editor: Editor, taskItemPos: number, taskId: string, label: string): boolean {
  const item = editor.state.doc.nodeAt(taskItemPos);
  const mentionType = editor.schema.nodes.contentMention;
  if (!item || item.type.name !== "taskItem" || !mentionType || !item.firstChild) return false;
  if (summarizeTaskItem(item).taskId) return false;
  const paragraph = item.firstChild;
  // taskItem 前置 pos +1 进 item，+1 进首段：首段内容起点 = taskItemPos + 2
  const insertAt = taskItemPos + 2 + paragraph.content.size;
  const chip = mentionType.create({ kind: "task", displayMode: null, id: taskId, aux: null, versionId: null, label });
  const needsSpace = paragraph.content.size > 0 && !(paragraph.lastChild?.isText && /\s$/.test(paragraph.lastChild.text ?? ""));
  const nodes = needsSpace ? [editor.schema.text(" "), chip] : [chip];
  editor.view.dispatch(editor.state.tr.insert(insertAt, nodes));
  return true;
}

export type TaskBarLayout = { left: number; top: number; placement: "above" | "below" };

/** 浮条贴在任务项上方、与行首对齐；顶部放不下就放到行下方。左右夹进视口。 */
export function taskBarLayout(
  item: Pick<DOMRect, "left" | "top" | "bottom">,
  viewport: { width: number; height: number },
  options: { barHeight?: number; barWidth?: number; gap?: number; padding?: number } = {},
): TaskBarLayout {
  const barHeight = options.barHeight ?? 32;
  const barWidth = options.barWidth ?? 360;
  const gap = options.gap ?? 6;
  const padding = options.padding ?? 8;
  const placement: TaskBarLayout["placement"] = item.top - gap - barHeight >= padding ? "above" : "below";
  const top = placement === "above" ? item.top - gap - barHeight : item.bottom + gap;
  const left = Math.max(padding, Math.min(item.left, viewport.width - barWidth - padding));
  return { left, top, placement };
}
