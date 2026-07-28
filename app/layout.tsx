import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { cookies } from "next/headers";
import { getSession } from "@/lib/session";
import { listMyProductionsWithRoles } from "@/lib/db";
import ManualSaveNotice from "@/components/ManualSaveNotice";
import AppShell from "@/components/AppShell";
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
  title: { template: "%s | Click-In", default: "Click-In" },
  description: "演出项目管理",
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const cookieStore = await cookies();
  const session = getSession(cookieStore);

  const productions = session
    ? await listMyProductionsWithRoles(session.userId, session.isAdmin)
    : [];

  const shellSession = session
    ? { name: session.name, avatarUrl: session.avatarUrl }
    : null;

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
        <AppShell session={shellSession} productions={productions}>
          {children}
        </AppShell>
      </body>
    </html>
  );
}
