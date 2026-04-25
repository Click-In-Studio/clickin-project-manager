import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { getSession } from "@/lib/session";
import { listProductions } from "@/lib/db";
import HomeClient from "@/components/HomeClient";

export default async function Home() {
  const cookieStore = await cookies();
  const session = getSession(cookieStore);
  if (!session) redirect("/login");

  const productions = await listProductions({ openId: session.openId, isAdmin: session.isAdmin });

  return (
    <HomeClient
      productions={productions}
      isAdmin={session.isAdmin}
      currentUser={{ name: session.name, avatarUrl: session.avatarUrl }}
    />
  );
}
