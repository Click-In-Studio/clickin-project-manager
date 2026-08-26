/** 开关态的小滑块（纯呈现）。剧本编辑器与打印工具条共用。 */
export default function ModeSwitch({
  active,
  activeClassName = "bg-teal-600",
}: {
  active: boolean;
  activeClassName?: string;
}) {
  return (
    <span
      aria-hidden
      className={`relative h-4 w-7 rounded-full transition-colors ${
        active ? activeClassName : "bg-zinc-200"
      }`}
    >
      <span
        className={`absolute left-0.5 top-0.5 h-3 w-3 rounded-full bg-white shadow-sm transition-transform ${
          active ? "translate-x-3" : "translate-x-0"
        }`}
      />
    </span>
  );
}
