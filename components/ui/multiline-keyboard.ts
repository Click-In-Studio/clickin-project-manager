type MultilineKeyboardEvent = {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  isComposing?: boolean;
  nativeEvent?: { isComposing?: boolean };
};

/** 多行编辑面统一保留 Enter 换行，只用 Mod+Enter 执行提交动作。 */
export function isMultilineSubmitShortcut(event: MultilineKeyboardEvent): boolean {
  const isComposing = event.isComposing || event.nativeEvent?.isComposing;
  return event.key === "Enter" && (event.metaKey || event.ctrlKey) && !isComposing;
}
