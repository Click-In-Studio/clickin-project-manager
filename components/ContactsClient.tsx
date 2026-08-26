"use client";

import PageHeader from "@/components/PageHeader";
import { BASE_PATH } from "@/lib/base-path";
import type { MemberWithRoles } from "@/lib/db";
import { ROLE_GROUPS } from "@/lib/roles";
import { isInactiveMember, memberStatusLabel } from "@/lib/member-status-shared";

const ROLE_ORDER = ROLE_GROUPS.flatMap((g) => g.roles);

function sortByFirstRole(members: MemberWithRoles[]): MemberWithRoles[] {
  return [...members].sort((a, b) => {
    const ai = a.roles.length ? ROLE_ORDER.indexOf(a.roles[0]) : Infinity;
    const bi = b.roles.length ? ROLE_ORDER.indexOf(b.roles[0]) : Infinity;
    if (ai !== bi) return ai - bi;
    return a.name.localeCompare(b.name, "zh");
  });
}

// ─── MemberCard ───────────────────────────────────────────────────────────────

function resolvePhoto(raw: string | null): string | null {
  if (!raw) return null;
  if (raw.startsWith("http")) return raw;
  return `${BASE_PATH}/api/media?token=${encodeURIComponent(raw)}`;
}

const ROLE_TONES = [
  { background: "#e8f1f2", color: "#315f66" },
  { background: "#f5eadf", color: "#8a4d2f" },
  { background: "#ece9f6", color: "#5c527f" },
  { background: "#e8f3e9", color: "#3f6b48" },
  { background: "#f7e8eb", color: "#8c4654" },
];

function roleTone(role: string): React.CSSProperties {
  const defaultIndex = ROLE_ORDER.indexOf(role);
  if (defaultIndex >= 0) return ROLE_TONES[defaultIndex % ROLE_TONES.length];

  // ROLE_ORDER 是默认模板顺序，不是角色白名单。自定义角色按名称稳定散列，
  // 避免所有未命中项都回落到第一种颜色。
  let hash = 0;
  for (const char of role) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  const index = Math.abs(hash);
  return ROLE_TONES[index % ROLE_TONES.length];
}

function MemberCard({ member }: { member: MemberWithRoles }) {
  const photo = resolvePhoto(member.photoUrl) ?? member.avatarUrl;

  // v3 纯展示卡：小圆头像 + 名字 + 角色/标签徽章（无编辑入口）
  return (
    <div style={{
      background: "white", border: "1px solid var(--line)", borderRadius: 10,
      padding: "14px 12px", display: "flex", flexDirection: "column", alignItems: "center", gap: 8,
      textAlign: "center",
    }}>
      <div style={{
        width: 52, height: 52, borderRadius: "50%", overflow: "hidden", flexShrink: 0,
        background: "var(--surface-2)", display: "flex", alignItems: "center", justifyContent: "center",
      }}>
        {photo ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={photo} alt={member.name} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
        ) : (
          <span style={{ fontSize: 18, fontWeight: 500, color: "var(--muted)" }}>{member.name[0]}</span>
        )}
      </div>

      <div style={{ minWidth: 0, width: "100%" }}>
        <p style={{ margin: 0, fontFamily: 'Georgia, "Noto Serif SC", serif', fontSize: 17, fontWeight: 500, color: "var(--ink)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {member.name}
          {isInactiveMember(member.status) && (
            <span style={{ marginLeft: 4, borderRadius: 4, padding: "1px 4px", fontSize: 9, fontWeight: 600, background: "var(--danger-soft)", color: "var(--danger)", fontFamily: "system-ui, sans-serif", verticalAlign: 2 }}>{memberStatusLabel(member.status, member.statusSource ?? null)}</span>
          )}
        </p>
        {member.roles.length > 0 && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 3, justifyContent: "center", marginTop: 6 }}>
            {member.roles.map((r) => (
              <span key={r} style={{ borderRadius: 999, padding: "2px 7px", fontSize: 9, fontWeight: 700, ...roleTone(r) }}>
                {r}
              </span>
            ))}
          </div>
        )}
        {member.tags.length > 0 && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 3, justifyContent: "center", marginTop: 4 }}>
            {member.tags.map((t) => (
              <span key={t} style={{ borderRadius: 999, background: "var(--script-soft)", padding: "2px 7px", fontSize: 9, fontWeight: 700, color: "var(--script)" }}>
                {t}
              </span>
            ))}
          </div>
        )}
        {member.email && (
          <p style={{ margin: "6px 0 0", fontSize: 10, color: "var(--muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {member.email}
          </p>
        )}
      </div>
    </div>
  );
}

// ─── ContactsClient ───────────────────────────────────────────────────────────

// 纯展示页（v3）：人事编辑/导入/添加入口已移除——人事操作归管理后台，
// 拉人一律走「数据迁移」页的批量邀请（发码），不在这里替人建号。

export default function ContactsClient({
  initialMembers,
}: {
  initialMembers: MemberWithRoles[];
}) {
  const sorted = sortByFirstRole(initialMembers);

  return (
    <div style={{ padding: "24px clamp(18px, 3vw, 52px) 60px", minHeight: "100vh", background: "var(--paper)" }}>
      <PageHeader eyebrow="People" title="人员" side="stage" />

      <div style={{ background: "var(--surface)", borderRadius: 13, border: "1px solid var(--line)", padding: 22, minHeight: "calc(100vh - 280px)" }}>
        {sorted.length === 0 ? (
          <div style={{ padding: "48px 0", textAlign: "center" }}>
            <p style={{ fontSize: 13, color: "var(--muted)" }}>暂无人员</p>
          </div>
        ) : (
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-7 xl:grid-cols-8">
            {sorted.map((m) => (
              <MemberCard key={m.userId} member={m} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
