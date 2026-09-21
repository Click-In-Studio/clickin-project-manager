import type { MemberWithRoles } from "@/lib/perm/member-db";

export function groupByRole(members: MemberWithRoles[]): { role: string; members: MemberWithRoles[] }[] {
  const order: string[] = [];
  const map = new Map<string, MemberWithRoles[]>();
  for (const m of members) {
    const roles = m.roles.length > 0 ? m.roles : ["其他"];
    for (const role of roles) {
      if (!map.has(role)) { map.set(role, []); order.push(role); }
      map.get(role)!.push(m);
    }
  }
  return order.map(role => ({ role, members: map.get(role)! }));
}
