import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { cookies } from "next/headers";
import { getSession } from "@/lib/session";
import { listMyProductionsWithRoles } from "@/lib/db";
import { countUnreadNotifications } from "@/lib/inbox-db";
import { countPendingTasksForUser, countUnreadReportsForUser } from "@/lib/event-db";
import { ADMIN_PANEL_NODE_PREFIXES } from "@/lib/permissions";
import { getUserTier, PRODUCTION_TIERS } from "@/lib/plan";
import ManualSaveNotice from "@/components/ManualSaveNotice";
import AppShell from "@/components/AppShell";
// 剧本字体的 @font-face（生成文件，见 scripts/fonts/build-fonts.py）；先于 globals.css 引入
import "./fonts.css";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: { template: "%s | Backstage", default: "Backstage" },
  description: "演出项目管理",
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const cookieStore = await cookies();
  const session = getSession(cookieStore);

  const adminPanelPerms = [...ADMIN_PANEL_NODE_PREFIXES];
  const [rawProductions, unreadNotificationCount, pendingTaskCount, unreadReportCount, userTier] = await Promise.all([
    session ? listMyProductionsWithRoles(session.userId, session.isAdmin, adminPanelPerms) : Promise.resolve([]),
    session ? countUnreadNotifications(session.userId) : Promise.resolve(0),
    session ? countPendingTasksForUser(session.userId) : Promise.resolve(0),
    session ? countUnreadReportsForUser(session.userId) : Promise.resolve(0),
    session ? getUserTier(session.userId) : Promise.resolve(null),
  ]);

  const productions = rawProductions.map((p) => ({
    ...p,
    // canAdmin: FK-backed path (hasAdminPerm), owner, system admin,
    // or fallback text-role path for pre-migration productions.
    canAdmin: session!.isAdmin || p.isOwner || p.hasAdminPerm,
    // 档位开关（#280）：付费维度，与 canAdmin 那条权限维度正交——权限决定视图里
    // 能看到什么内容，档位决定菜单里有没有这一项。lib/plan.ts 的常量表不能进客户端
    // 包，所以在这里解析成布尔值下发。
    planAi: PRODUCTION_TIERS[p.planTier].ai,
    planAdvancedPerms: PRODUCTION_TIERS[p.planTier].advancedPerms,
  }));

  const shellSession = session
    ? { userId: session.userId, name: session.name, avatarUrl: session.avatarUrl }
    : null;

  // 建项目入口的显隐是用户等级（付费维度）：user_plan 无行的普通注册用户菜单里
  // 根本没有「新建项目」。配额满不在此列——那是有等级的人的用量问题，按钮照常显示，
  // 由 POST /api/productions 回明确文案。
  const canCreateProduction = userTier !== null;

  return (
    <html
      lang="zh"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <head>
        <link
          rel="preload"
          href="/fonts/SourceHanSerifCN-Medium.woff2"
          as="font"
          type="font/woff2"
          crossOrigin="anonymous"
        />
        <link
          rel="preload"
          href="/fonts/SourceHanSerifCN-Bold.woff2"
          as="font"
          type="font/woff2"
          crossOrigin="anonymous"
        />
      </head>
      <body className="h-full overflow-hidden">
        <ManualSaveNotice />
        <AppShell session={shellSession} productions={productions} canCreateProduction={canCreateProduction} initialUnreadCount={unreadNotificationCount} initialPendingTasks={pendingTaskCount} initialUnreadReports={unreadReportCount}>
          {children}
        </AppShell>
      </body>
    </html>
  );
}
