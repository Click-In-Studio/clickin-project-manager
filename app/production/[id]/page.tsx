import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import Link from "next/link";
import { getSession } from "@/lib/session";
import { canUserAccessProduction, getProductionName } from "@/lib/db";

export default async function ProductionDashboard({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const cookieStore = await cookies();
  const session = getSession(cookieStore);
  if (!session) redirect("/login");

  if (!session.isAdmin) {
    const ok = await canUserAccessProduction(session.openId, id);
    if (!ok) redirect("/");
  }

  const name = await getProductionName(id);
  if (!name) redirect("/");

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-zinc-100 px-4">
      <div className="w-full max-w-xs">
        <div className="mb-8 flex items-center justify-between">
          <Link href="/" className="text-xs text-zinc-400 hover:text-zinc-600 transition-colors">
            ← 返回
          </Link>
          <h1 className="text-sm font-bold tracking-[0.2em] text-zinc-400 uppercase">{name}</h1>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Link
            href={`/production/${id}/contacts`}
            className="rounded-2xl bg-white px-4 py-8 shadow-sm text-center hover:shadow-md transition-shadow"
          >
            <p className="text-xs font-semibold tracking-widest text-zinc-300 uppercase mb-1">People</p>
            <p className="text-base font-medium text-zinc-700">人员</p>
          </Link>
          <Link
            href={`/production/${id}/script`}
            className="rounded-2xl bg-white px-4 py-8 shadow-sm text-center hover:shadow-md transition-shadow"
          >
            <p className="text-xs font-semibold tracking-widest text-zinc-300 uppercase mb-1">Script</p>
            <p className="text-base font-medium text-zinc-700">剧本</p>
          </Link>
        </div>
      </div>
    </div>
  );
}
