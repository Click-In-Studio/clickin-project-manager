import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/session";
import { getUserProfile, getUserIdentities } from "@/lib/db";
import AccountClient from "./AccountClient";

export const metadata: Metadata = { title: "个人中心" };

export default async function AccountPage() {
  const cookieStore = await cookies();
  const session = getSession(cookieStore);
  if (!session) redirect("/login");

  const [profile, identities] = await Promise.all([
    getUserProfile(session.userId),
    getUserIdentities(session.userId),
  ]);

  return (
    <AccountClient
      initialProfile={{
        name: profile?.name ?? session.name,
        avatarUrl: profile?.avatarUrl ?? session.avatarUrl,
      }}
      initialIdentities={identities}
    />
  );
}
