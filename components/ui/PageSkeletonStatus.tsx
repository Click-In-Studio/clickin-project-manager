"use client";

import { usePathname } from "next/navigation";
import { pageTitleFor } from "./page-skeleton-title";

/**
 * 骨架屏顶上那一行可见的「正在打开「××」…」+ 转圈（#652）。
 *
 * 单独拆成客户端组件只为读 usePathname：loading.tsx 作为 Suspense fallback
 * 渲染时 URL 已经是目标页，这里拿到的就是要去哪。转圈与侧栏 NavItem 同一款。
 */
export default function PageSkeletonStatus() {
  const pathname = usePathname();
  const title = pageTitleFor(pathname ?? "");
  return (
    <p
      className="flex items-center gap-2 text-[12px] text-[var(--muted)]"
      style={{ margin: "0 0 18px" }}
      aria-live="polite"
    >
      <span
        className="h-3 w-3 shrink-0 animate-spin rounded-full border-[1.5px] border-current border-t-transparent"
        aria-hidden
      />
      <span>{title ? `正在打开「${title}」…` : "正在打开…"}</span>
    </p>
  );
}
