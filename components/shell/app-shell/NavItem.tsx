"use client";

import { useEffect, useContext } from "react";
import Link, { useLinkStatus } from "next/link";
import { NavPendingContext } from "./nav-pending";

export default function NavItem({
  href,
  symbol,
  label,
  hint,
  active,
  badge,
  warningBadge,
  onClick,
  folded,
  side,
}: {
  href: string;
  symbol: string;
  label: string;
  hint: string;
  active: boolean;
  /** 分侧配色（原型 scriptSymbol/stageSymbol）：创作侧青系、制作侧橙系 */
  side?: "script" | "stage";
  badge?: number;
  warningBadge?: number;
  onClick?: () => void;
  folded?: boolean;
}) {
  const foldedBadge = folded ? Math.max(badge ?? 0, warningBadge ?? 0) : 0;
  // 有项在途时，高亮完全交给它；否则回落到 pathname 推导的 active。
  const { href: pendingHref } = useContext(NavPendingContext);
  const effectiveActive = pendingHref !== null ? pendingHref === href : active;

  return (
    <Link
      href={href}
      onClick={onClick}
      aria-label={folded ? `${label}${foldedBadge > 0 ? ` ${foldedBadge}` : ""}` : undefined}
      title={folded ? label : undefined}
      className={`flex min-h-[46px] items-center rounded-[9px] px-2.5 py-1.5 transition-colors ${
        folded ? "relative justify-center" : "gap-2.5 overflow-hidden"
      } ${
        effectiveActive
          ? "bg-[var(--surface)] shadow-[inset_3px_0_0_#182a2a]"
          : "hover:bg-white/50"
      }`}
    >
      <NavItemSymbol href={href} symbol={symbol} side={side} />
      {folded ? (
        foldedBadge > 0 && (
          <span className={`absolute right-1 top-1 flex h-4 min-w-[16px] items-center justify-center rounded-full px-1 text-[9px] font-bold leading-none text-white ${
            (warningBadge ?? 0) >= foldedBadge ? "bg-amber-500" : "bg-[#c0392b]"
          }`}>
            {foldedBadge > 99 ? "99+" : foldedBadge}
          </span>
        )
      ) : (
        <span className="flex min-w-0 flex-1 flex-col overflow-hidden whitespace-nowrap">
          <span className="flex min-w-0 items-center gap-1.5 overflow-hidden">
            <span className="min-w-0 truncate text-[12px] font-bold leading-tight text-[#182a2a]">{label}</span>
            {badge != null && badge > 0 && (
              <span className="flex h-4 min-w-[16px] shrink-0 items-center justify-center rounded-full bg-[#c0392b] px-1 text-[9px] font-bold leading-none text-white">
                {badge > 99 ? "99+" : badge}
              </span>
            )}
            {warningBadge != null && warningBadge > 0 && (
              <span className="flex h-4 min-w-[16px] shrink-0 items-center justify-center rounded-full bg-amber-500 px-1 text-[9px] font-bold leading-none text-white">
                {warningBadge > 99 ? "99+" : warningBadge}
              </span>
            )}
          </span>
          <span className="mt-0.5 truncate text-[9px] text-[#667676]">{hint}</span>
        </span>
      )}
    </Link>
  );
}

/**
 * NavItem 的符号方块。单独拆出来只为一件事：useLinkStatus 必须在 <Link>
 * 后代里调用。在途时符号换成转圈，并把 href 上报给 NavPendingContext。
 */
function NavItemSymbol({ href, symbol, side }: { href: string; symbol: string; side?: "script" | "stage" }) {
  const { pending } = useLinkStatus();
  const { report } = useContext(NavPendingContext);

  useEffect(() => {
    report(href, pending);
    // 卸载（如抽屉关闭）时撤回，免得 pending 态卡死高亮。
    return () => report(href, false);
  }, [href, pending, report]);

  return (
    <span className={`flex h-[27px] w-[27px] shrink-0 items-center justify-center rounded-[7px] border text-[11px] leading-none ${
      side === "script"
        ? "border-[#bfd4d6] bg-[#edf5f5] text-[#2f6670]"
        : side === "stage"
        ? "border-[#e3c9b9] bg-[#f8eee7] text-[#a55c32]"
        : "border-[#cbd2cf] text-[#667676]"
    }`}>
      {pending ? (
        <span
          className="h-3 w-3 animate-spin rounded-full border-[1.5px] border-current border-t-transparent"
          aria-hidden
        />
      ) : (
        symbol
      )}
    </span>
  );
}
