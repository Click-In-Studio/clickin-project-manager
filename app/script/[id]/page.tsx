import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { getSession } from "@/lib/session";
import { canUserAccessProduction } from "@/lib/db";
import ScriptEditor from "@/components/ScriptEditor";

export default async function ProductionPage({
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
  return <ScriptEditor productionId={id} />;
}
