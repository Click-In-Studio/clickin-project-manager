import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { getSession } from "@/lib/session";
import { getProductionName } from "@/lib/db";

export const metadata: Metadata = { title: "计划与日程" };

export default async function PlanningPage({ params }: { params: Promise<{ id: string }> }) {
  const cookieStore = await cookies();
  const session = getSession(cookieStore);
  if (!session) redirect("/login");

  const { id } = await params;
  const name = await getProductionName(id);
  if (!name) redirect("/");

  return (
    <div className="px-8 py-10">
      <p className="text-[10px] font-bold tracking-[0.14em] uppercase text-[#667676] mb-1">舞台侧 · {name}</p>
      <h1 className="font-serif text-3xl font-medium text-[#182a2a] tracking-tight mb-8" style={{ fontFamily: 'Georgia, "Noto Serif SC", serif' }}>
        计划与日程
      </h1>
      <div className="rounded-2xl border border-[#dfe5e2] bg-white px-8 py-10 text-center max-w-sm">
        <p className="text-sm font-medium text-[#182a2a] mb-1">功能即将上线</p>
        <p className="text-xs text-[#667676]">日历 · 甘特 · 执行表 正在开发中</p>
      </div>
    </div>
  );
}
