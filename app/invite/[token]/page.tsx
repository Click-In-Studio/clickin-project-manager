import type { Metadata } from "next";
export const metadata: Metadata = { title: "项目邀请" };

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/session";
import { getInviteInfo } from "@/lib/invite-db";
import InviteAcceptClient from "@/components/InviteAcceptClient";

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const cookieStore = await cookies();
  const session = getSession(cookieStore);
  if (!session) redirect(`/login?next=${encodeURIComponent(`/invite/${token}`)}`);

  const info = /^[0-9a-f-]{36}$/i.test(token) ? await getInviteInfo(token) : null;

  return (
    <InviteAcceptClient
      token={token}
      productionName={info?.productionName ?? null}
      productionId={info?.productionId ?? null}
      status={info?.status ?? "not_found"}
      targetedEmail={info?.email ?? null}
    />
  );
}
