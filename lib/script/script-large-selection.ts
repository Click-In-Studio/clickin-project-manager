export const LARGE_SELECTION_BLOCK_THRESHOLD = 500;

export type LargeSelectionOperation = "delete" | "move" | "type" | "lyric";
export type PendingLargeSelectionConfirmation = {
  operation: LargeSelectionOperation;
  count: number;
  onConfirm: () => void;
  onCancel?: () => void;
};

export function largeSelectionOperationMessage(operation: LargeSelectionOperation, count: number) {
  const actionLabel =
    operation === "delete" ? "删除" :
    operation === "move" ? "移动" :
    operation === "type" ? "更改" :
    "更改";
  const objectLabel =
    operation === "type" ? `${count} 行的类型` :
    operation === "lyric" ? `${count} 行的文本状态` :
    `${count} 行`;
  return `${actionLabel} ${objectLabel}可能导致页面卡顿，建议分批次进行。\n是否确认继续操作？`;
}
