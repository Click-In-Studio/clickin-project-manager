"use client";

export type CueJumpTarget = "line" | "page" | "scene";
export const CUE_JUMP_OPTIONS: { target: CueJumpTarget; label: string }[] = [
  { target: "line", label: "行" },
  { target: "page", label: "页" },
  { target: "scene", label: "段落" },
];

export default function CueJumpOptions({ onSelect }: { onSelect: (target: CueJumpTarget) => void }) {
  return CUE_JUMP_OPTIONS.map(({ target, label }) => (
    <button
      key={target}
      type="button"
      onClick={() => onSelect(target)}
      className="w-full px-3 py-1.5 text-left text-sm text-zinc-600 hover:bg-zinc-50"
    >
      跳转到{label}…
    </button>
  ));
}
