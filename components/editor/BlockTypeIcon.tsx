"use client";

// 块类型图标片 —— `/` 插入菜单与手柄的「转换为」菜单共用。
//
// 图标本身来自 lib/editor-block-types 的定式表，这里统一的是**观感**：
// 两个菜单里同一个块类型必须长得一模一样，否则用户会以为「新建 · 高亮块」
// 和「转换为 · 高亮块」是两个不同的东西。

export default function BlockTypeIcon({ icon, active }: { icon?: string; active?: boolean }) {
  return (
    <span
      className={`inline-flex items-center justify-center w-6 h-6 rounded text-[13px] shrink-0 ${
        active ? "bg-zinc-800 text-white" : "bg-zinc-100 text-zinc-600"
      }`}
    >
      {icon}
    </span>
  );
}
