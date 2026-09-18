"use client";

// 手册文章页底部的「报告问题」入口（#538）。登录用户打开同一个 BugReportModal
// （自动带上本页 slug、默认选「手册写得不对」）；未登录访客只看到联系方式——
// 手册是公开页，不给匿名表单。

import { useState } from "react";
import BugReportModal from "./BugReportModal";
import type { BugReportKind } from "@/lib/help/bug-report-db";

export default function HelpReportEntry({ slug, loggedIn }: { slug: string; loggedIn: boolean }) {
  const [open, setOpen] = useState<BugReportKind | null>(null);
  return (
    <div className="help-report">
      <div className="help-report-title">这一页帮到你了吗？</div>
      {loggedIn ? (
        <p>
          <button type="button" onClick={() => setOpen("manual")}>这一页写的不对</button>
          <span aria-hidden> · </span>
          <button type="button" onClick={() => setOpen("bug")}>功能有问题</button>
          <span aria-hidden> · </span>
          <button type="button" onClick={() => setOpen("suggestion")}>提个建议</button>
        </p>
      ) : (
        <p>登录 Backstage 之后，这里可以直接报告问题；页面里说的和你看到的不一样，也请告诉我们。</p>
      )}
      {open && <BugReportModal onClose={() => setOpen(null)} manualSlug={slug} defaultKind={open} />}
    </div>
  );
}
