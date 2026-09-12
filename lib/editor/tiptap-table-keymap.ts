// 表格键盘行为 —— 「点了外缘选中整行/整列，按 Delete 就删掉它」。
//
// 默认行为不是这样：prosemirror-tables 对 CellSelection 的删除是**清空内容**、
// 保留结构。那在「拖选几个单元格」时是对的，但在「从外缘点选了一整行」时不对
// ——用户明确指着一整行说删，却只被清空，看起来像没生效。
//
// 判据用 CellSelection 自带的 isRowSelection / isColSelection：它们看的是选区
// 是否横跨整行/整列，而不是"选中是从哪个 UI 触发的"。于是拖选覆盖了一整行的
// 情况也一并适用，行为一致，不需要在选中上打标记。
//
// priority 必须高于默认：tiptap 按优先级注册快捷键插件，PM 取第一个返回 true
// 的。不抬高的话 prosemirror-tables 的清空逻辑会先接走。
import { Extension } from "@tiptap/core";
import { CellSelection } from "@tiptap/pm/tables";

export const TableKeymap = Extension.create({
  name: "clickinTableKeymap",
  priority: 200,

  addKeyboardShortcuts() {
    const removeSelected = () => {
      const sel = this.editor.state.selection;
      if (!(sel instanceof CellSelection)) return false;
      const isRow = sel.isRowSelection();
      const isCol = sel.isColSelection();
      // 整行 + 整列同时成立 = 选了整张表
      if (isRow && isCol) return this.editor.chain().focus().deleteTable().run();
      if (isCol) return this.editor.chain().focus().deleteColumn().run();
      if (isRow) return this.editor.chain().focus().deleteRow().run();
      return false; // 部分选中 → 交还给默认的"清空内容"
    };
    return { Delete: removeSelected, Backspace: removeSelected };
  },
});
