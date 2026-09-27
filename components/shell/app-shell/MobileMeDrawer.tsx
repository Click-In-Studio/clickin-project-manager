"use client";

import { useState } from "react";
import { BASE_PATH } from "@/lib/base-path";
import BugReportModal from "@/components/help/BugReportModal";
import BottomDrawer from "./BottomDrawer";
import NavItem from "./NavItem";
import UserAvatarContent from "./UserAvatarContent";
import { helpHrefFor } from "./help-link";

export default function MobileMeDrawer({
  open,
  onClose,
  name,
  avatarSrc,
  userInitial,
  pathname,
  accountTab,
  accountHref,
  helpRoutes,
  latestChangelogVersion,
  changelogNew,
  onChangelogSeen,
  adminHref,
  adminName,
  adminActive,
}: {
  open: boolean;
  onClose: () => void;
  name: string;
  avatarSrc: string | null;
  userInitial: string;
  pathname: string;
  accountTab: string | null;
  accountHref: (tab: "profile" | "security" | "preferences") => string;
  helpRoutes: Record<string, string>;
  latestChangelogVersion: string | null;
  changelogNew: boolean;
  onChangelogSeen: () => void;
  adminHref: string | null;
  adminName: string | null;
  adminActive: boolean;
}) {
  const [reporting, setReporting] = useState(false);
  const helpHref = helpHrefFor(pathname, helpRoutes);
  const closeAndReport = () => {
    onClose();
    setReporting(true);
  };

  return (
    <>
      <BottomDrawer open={open} onClose={onClose}>
        <div className="pb-4">
          <div className="flex items-center gap-3 px-5 pt-1 pb-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-full bg-[#182a2a]">
              <UserAvatarContent src={avatarSrc} initial={userInitial} />
            </span>
            <span className="text-[14px] font-bold text-[#182a2a]">{name}</span>
          </div>
          <DrawerDivider />

          <div className="flex flex-col gap-0.5 px-3.5 pt-1">
            <NavItem
              href={accountHref("profile")}
              symbol="人"
              label="个人信息"
              hint="头像 · 姓名 · 简介"
              active={pathname === "/account" && accountTab !== "security" && accountTab !== "preferences"}
              onClick={onClose}
            />
            <NavItem
              href={accountHref("security")}
              symbol="盾"
              label="账号安全中心"
              hint="登录方式 · 绑定身份"
              active={pathname === "/account" && accountTab === "security"}
              onClick={onClose}
            />
          </div>

          <DrawerDivider />
          <div className="flex flex-col gap-0.5 px-3.5">
            <NavItem
              href={accountHref("preferences")}
              symbol="调"
              label="功能与设置"
              hint="通知 · 消息提醒"
              active={pathname === "/account" && accountTab === "preferences"}
              onClick={onClose}
            />
          </div>

          <DrawerDivider />
          <div className="flex flex-col gap-0.5 px-3.5">
            <NavItem href={helpHref} symbol="?" label="本页帮助" hint="查看当前页面的操作说明" active={false} onClick={onClose} />
            <NavItem href="/help" symbol="册" label="使用手册" hint="浏览全部功能说明" active={pathname === "/help"} onClick={onClose} />
            <NavItem
              href="/help/changelog"
              symbol={changelogNew ? "新" : "志"}
              label="更新日志"
              hint={changelogNew ? "有新版本内容可查看" : "查看最近的功能变化"}
              active={pathname === "/help/changelog"}
              onClick={() => {
                onClose();
                if (latestChangelogVersion) onChangelogSeen();
              }}
            />
            <DrawerActionItem symbol="报" label="报告问题" hint="反馈异常或使用疑问" onClick={closeAndReport} />
          </div>

          {adminHref && (
            <>
              <DrawerDivider />
              <div className="flex flex-col gap-0.5 px-3.5">
                <NavItem href={adminHref} symbol="⚙" label="配置中心" hint={adminName ?? "项目设置"} active={adminActive} onClick={onClose} />
              </div>
            </>
          )}

          <div className="mx-5 my-2 border-t border-[var(--line)]" />
          <div className="px-5">
            <form action={`${BASE_PATH}/api/auth/logout`} method="post">
              <button type="submit" className="flex w-full items-center gap-2 py-2.5 text-left text-sm text-[#c0392b]">
                退出登录
              </button>
            </form>
          </div>
        </div>
      </BottomDrawer>

      {reporting && <BugReportModal onClose={() => setReporting(false)} />}
    </>
  );
}

function DrawerDivider() {
  return <div className="mx-5 my-1.5 border-t border-[var(--line)]" />;
}

function DrawerActionItem({ symbol, label, hint, onClick }: {
  symbol: string;
  label: string;
  hint: string;
  onClick: () => void;
}) {
  return (
    <button type="button" onClick={onClick} className="flex min-h-[46px] items-center gap-2.5 rounded-[9px] px-2.5 py-1.5 text-left transition-colors hover:bg-white/50">
      <span className="flex h-[27px] w-[27px] shrink-0 items-center justify-center rounded-[7px] border border-[#cbd2cf] text-[11px] leading-none text-[#667676]">
        {symbol}
      </span>
      <span className="flex min-w-0 flex-1 flex-col overflow-hidden whitespace-nowrap">
        <span className="truncate text-[12px] font-bold leading-tight text-[#182a2a]">{label}</span>
        <span className="mt-0.5 truncate text-[9px] text-[#667676]">{hint}</span>
      </span>
    </button>
  );
}
