"use client";

// 顶栏头像 + 下拉菜单（#538 从 AppShell 抽出，顺带装进「本页帮助 / 报告问题」）。
// 点外关闭的监听挂 document（App Router 下 React 事件也挂 document，
// stopPropagation 拦不住它，见 feedback_stoppropagation_document_root）。

import { useEffect, useRef, useState } from "react";
import { BASE_PATH } from "@/lib/base-path";
import DropdownItem from "./DropdownItem";
import UserAvatarContent from "./UserAvatarContent";
import { helpHrefFor } from "./help-link";
import BugReportModal from "@/components/help/BugReportModal";

export default function UserMenu({
  name, avatarSrc, userInitial, unreadCount, pathname, helpRoutes, accountHref, adminHref, adminName, hidden,
}: {
  name: string;
  avatarSrc: string | null;
  userInitial: string;
  unreadCount: number;
  pathname: string;
  /** 产品路由 → 手册页 slug（RootLayout 从 content/manual 算出下发） */
  helpRoutes: Record<string, string>;
  accountHref: (tab: "profile" | "security" | "preferences") => string;
  /** 有管理面资格时给配置中心链接 */
  adminHref: string | null;
  adminName: string | null;
  /** 顶栏收窄到第二档时整个隐藏（与原 AppShell 行为一致） */
  hidden: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [reporting, setReporting] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const close = () => setOpen(false);
  const helpHref = helpHrefFor(pathname, helpRoutes);

  return (
    <div className={`relative shrink-0 ${hidden ? "hidden" : "block"}`} ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
        aria-label="个人中心"
        aria-expanded={open}
        className="relative w-9 h-9 rounded-full border border-[var(--line)] overflow-hidden bg-[#182a2a] flex items-center justify-center hover:opacity-90 transition-opacity shrink-0"
      >
        <UserAvatarContent src={avatarSrc} initial={userInitial} />
        {unreadCount > 0 && (
          <span className="absolute top-0 right-0 w-2.5 h-2.5 rounded-full bg-[#c0392b] border-2 border-[var(--surface)]" />
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-2.5 w-[240px] bg-[var(--surface)] border border-[var(--line)] rounded-[13px] shadow-[0_18px_55px_rgba(24,42,42,.18)] z-50 overflow-hidden p-2">
          {/* ── 用户概要 ── */}
          <div className="flex items-center gap-2.5 px-2 py-2 mb-1 border-b border-[var(--line)]">
            <span className="w-9 h-9 rounded-full bg-[#182a2a] overflow-hidden shrink-0 flex items-center justify-center">
              <UserAvatarContent src={avatarSrc} initial={userInitial} />
            </span>
            <div className="flex flex-col min-w-0">
              <span className="text-[11px] font-bold text-[#182a2a] truncate">{name}</span>
            </div>
          </div>

          {/* ── 账户 ── */}
          <DropdownItem href={accountHref("profile")} onClick={close}>个人信息</DropdownItem>
          <DropdownItem href={accountHref("security")} onClick={close}>账号安全中心</DropdownItem>

          {/* ── 偏好 ── */}
          <div className="h-px bg-[var(--line)] mx-1 my-1.5" />
          <DropdownItem href={accountHref("preferences")} onClick={close}>功能与设置</DropdownItem>

          {/* ── 帮助（#538）：本页帮助按当前路由落到对应手册页；报告问题只记 log ── */}
          <div className="h-px bg-[var(--line)] mx-1 my-1.5" />
          <DropdownItem href={helpHref} onClick={close}>本页帮助</DropdownItem>
          <DropdownItem href="/help" onClick={close}>使用手册</DropdownItem>
          <button
            type="button"
            onClick={() => { close(); setReporting(true); }}
            className="w-full text-left flex items-center gap-2 px-2.5 py-2 rounded-[7px] text-[11px] text-[#182a2a] hover:bg-[var(--paper)] transition-colors"
          >
            报告问题
          </button>

          {/* ── 配置中心 ── */}
          {adminHref && (
            <>
              <div className="h-px bg-[var(--line)] mx-1 my-1.5" />
              <DropdownItem href={adminHref} onClick={close}>
                配置中心
                <span className="ml-auto text-[10px] text-[#667676] truncate max-w-[90px]">{adminName}</span>
              </DropdownItem>
            </>
          )}

          {/* ── 退出 ── */}
          <div className="h-px bg-[var(--line)] mx-1 mt-1.5 mb-1" />
          <form action={`${BASE_PATH}/api/auth/logout`} method="post">
            <button
              type="submit"
              className="w-full text-left flex items-center px-2.5 py-2 rounded-[7px] text-[11px] text-[#c0392b] hover:bg-[var(--paper)] transition-colors"
            >
              退出登录
            </button>
          </form>
        </div>
      )}

      {reporting && <BugReportModal onClose={() => setReporting(false)} />}
    </div>
  );
}
