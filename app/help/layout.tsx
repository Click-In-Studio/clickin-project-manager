import type { Metadata } from "next";
import HelpHeader from "@/components/help/HelpHeader";
import "@/components/help/help.css";

// 使用手册（#531）：独立于 AppShell 的公开站点。proxy.ts 把 /help 列为公开前缀，
// AppShell 对 /help 直接透传 children——手册有自己的顶栏与三栏骨架。
export const metadata: Metadata = {
  title: { template: "%s | Backstage 使用手册", default: "Backstage 使用手册" },
  description: "Backstage 演出项目管理的功能说明与操作指南",
};

export default function HelpLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="help-root">
      <HelpHeader />
      {children}
    </div>
  );
}
