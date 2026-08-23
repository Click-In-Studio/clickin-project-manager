import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/session";
import { getUserProfile, getUserIdentities } from "@/lib/db";
import { getUserPrefs } from "@/lib/notification-prefs";
import { getUserTier, USER_TIERS } from "@/lib/plan";
import AccountClient from "./AccountClient";

export const metadata: Metadata = { title: "个人中心" };

export default async function AccountPage() {
  const cookieStore = await cookies();
  const session = getSession(cookieStore);
  if (!session) redirect("/login");

  const [profile, identities, notifPrefs, userTier] = await Promise.all([
    getUserProfile(session.userId),
    getUserIdentities(session.userId),
    getUserPrefs(session.userId),
    getUserTier(session.userId),
  ]);

  return (
    <AccountClient
      userId={session.userId}
      initialProfile={{
        name: profile?.name ?? session.name,
        displayName: profile?.displayName ?? null,
        bio: profile?.bio ?? null,
        preferredPlatform: profile?.preferredPlatform ?? null,
        avatarUrl: profile?.avatarUrl ?? session.avatarUrl,
      }}
      initialIdentities={identities}
      initialNotifPrefs={notifPrefs}
      initialPlan={userTier ? { tier: userTier, label: USER_TIERS[userTier].label } : null}
    />
  );
}
