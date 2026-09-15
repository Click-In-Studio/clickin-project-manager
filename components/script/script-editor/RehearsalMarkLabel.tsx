"use client";

export default function RehearsalMarkLabel({ mark }: { mark: string }) {
  return (
    <span className="flex items-start gap-1">
      <span
        data-rehearsal-triangle="true"
        className="rounded px-0.5 py-0 text-[8px] font-bold leading-none tracking-wide text-zinc-500"
      >
        ▶
      </span>
      <span className="text-[9px] font-bold leading-none tracking-wide text-zinc-500">
        {mark}
      </span>
    </span>
  );
}
