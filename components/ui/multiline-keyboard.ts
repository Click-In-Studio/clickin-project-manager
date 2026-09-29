type MultilineKeyboardEvent = {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey?: boolean;
  isComposing?: boolean;
  nativeEvent?: { isComposing?: boolean };
};

/** 多行编辑面统一保留 Enter 换行，只用 Mod+Enter 执行提交动作。 */
export function isMultilineSubmitShortcut(event: MultilineKeyboardEvent): boolean {
  const isComposing = event.isComposing || event.nativeEvent?.isComposing;
  return event.key === "Enter" && (event.metaKey || event.ctrlKey) && !isComposing;
}

/** Agent 对话：桌面 Enter 发送、Shift+Enter 换行；手机保留 Enter 换行。 */
export function isAgentChatSubmitShortcut(event: MultilineKeyboardEvent, isMobileViewport: boolean): boolean {
  const isComposing = event.isComposing || event.nativeEvent?.isComposing;
  if (event.key !== "Enter" || event.shiftKey || isComposing) return false;
  return !isMobileViewport || event.metaKey || event.ctrlKey;
}
