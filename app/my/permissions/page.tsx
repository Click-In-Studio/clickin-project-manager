import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { getSession } from "@/lib/account/session";
import PermissionsClient from "@/components/perm/PermissionsClient";

export const metadata: Metadata = { title: "我的权限" };

export default async function MyPermissionsPage() {
  const cookieStore = await cookies();
  const session = getSession(cookieStore);
  if (!session) redirect("/login");
  return <PermissionsClient />;
}
