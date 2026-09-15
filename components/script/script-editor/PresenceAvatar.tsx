"use client";

export default function PresenceAvatar({ name, color, title }: { name: string; color: string; title?: string }) {
  return (
    <div
      title={title ?? name}
      style={{ backgroundColor: color }}
      className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[10px] font-bold text-white"
    >
      {name.slice(0, 1)}
    </div>
  );
}
