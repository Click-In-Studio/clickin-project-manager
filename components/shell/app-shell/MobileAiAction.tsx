export default function MobileAiAction({
  open,
  onClick,
}: {
  open: boolean;
  onClick: () => void;
}) {
  return (
    <div className="flex w-12 shrink-0 items-center justify-center">
      <button
        type="button"
        data-ai-toggle
        onClick={onClick}
        aria-label={open ? "收起 AI 助手" : "打开 AI 助手"}
        aria-expanded={open}
        className={`grid h-10 w-10 place-items-center rounded-full border text-[10px] font-bold tracking-tight transition-[background-color,border-color,color,transform] active:scale-95 ${
          open
            ? "border-[var(--script)] bg-[var(--script)] text-white"
            : "border-[#182a2a] bg-[#182a2a] text-white"
        }`}
      >
        AI
      </button>
    </div>
  );
}
