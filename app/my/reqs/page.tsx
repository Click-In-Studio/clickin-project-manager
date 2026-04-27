import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { getSession } from "@/lib/session";
import { listMyTechReqsFull } from "@/lib/event-db";
import MyReqsClient from "@/components/MyReqsClient";

export default async function MyReqsPage() {
  const cookieStore = await cookies();
  const session = getSession(cookieStore);
  if (!session) redirect("/login");

  const reqs = await listMyTechReqsFull(session.openId);

  return (
    <MyReqsClient
      reqs={reqs}
      currentUserOpenId={session.openId}
    />
  );
}
