import type { Editor } from "@tiptap/core";

const TASK_HREF_RE = /^\/production\/([^/]+)\/tasks\/([^/?#]+)$/;

export type TaskItemContext = {
  pos: number;
  end: number;
  title: string;
  taskId: string | null;
  href: string | null;
};

export function taskHref(productionId: string, taskId: string): string {
  return `/production/${productionId}/tasks/${taskId}`;
}

export function taskIdFromHref(href: string): string | null {
  return TASK_HREF_RE.exec(href)?.[2] ?? null;
}

export function findTaskItemContext(editor: Editor): TaskItemContext | null {
  const { $from } = editor.state.selection;
  for (let depth = $from.depth; depth >= 1; depth--) {
    const node = $from.node(depth);
    if (node.type.name !== "taskItem") continue;
    const pos = $from.before(depth);
    let linkedHref: string | null = null;
    const text: string[] = [];
    node.descendants(child => {
      if (!child.isText) return;
      const link = child.marks.find(mark => mark.type.name === "link");
      const href = typeof link?.attrs.href === "string" ? link.attrs.href : "";
      if (taskIdFromHref(href)) {
        linkedHref ??= href;
        return;
      }
      text.push(child.text ?? "");
    });
    return {
      pos,
      end: pos + node.nodeSize,
      title: text.join("").replace(/[·•]\s*$/, "").trim(),
      taskId: linkedHref ? taskIdFromHref(linkedHref) : null,
      href: linkedHref,
    };
  }
  return null;
}

export function insertTaskLink(
  editor: Editor,
  taskItemPos: number,
  productionId: string,
  taskId: string,
): boolean {
  const node = editor.state.doc.nodeAt(taskItemPos);
  const linkType = editor.schema.marks.link;
  if (!node || node.type.name !== "taskItem" || !linkType || !node.firstChild) return false;
  let alreadyLinked = false;
  node.descendants(child => {
    if (child.marks.some(mark => mark.type === linkType && taskIdFromHref(String(mark.attrs.href ?? "")))) {
      alreadyLinked = true;
    }
  });
  if (alreadyLinked) return true;

  // taskItem > paragraph 的正文起点是 itemPos + 2，追加到首段末尾，避免把链接
  // 插进后续嵌套列表里。
  const paragraph = node.firstChild;
  const insertAt = taskItemPos + 2 + paragraph.content.size;
  const href = taskHref(productionId, taskId);
  const tr = editor.state.tr.insertText(" · ", insertAt);
  tr.insertText("打开任务", insertAt + 3);
  tr.addMark(insertAt + 3, insertAt + 7, linkType.create({ href }));
  editor.view.dispatch(tr);
  return true;
}
