"use client";

import { BASE_PATH } from "@/lib/base-path";
import { userAvatarSrc } from "@/lib/asset/avatar-url";
import type { MemberWithRoles } from "@/lib/perm/member-db";
import { ROLE_GROUPS } from "@/lib/perm/roles";
import { isInactiveMember, memberStatusLabel } from "@/lib/perm/member-status-shared";
import styles from "./contacts.module.css";

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
  const photo = resolvePhoto(member.photoUrl) ?? userAvatarSrc(member.userId, member.avatarUrl);

  // v3 纯展示卡：小圆头像 + 名字 + 角色/标签徽章（无编辑入口）
  return (
    <div className={styles.memberCard}>
      <div className={styles.avatar}>
        {photo ? (
          <img src={photo} alt={member.name} className={styles.avatarImage} />
        ) : (
          <span className={styles.avatarFallback}>{member.name[0]}</span>
        )}
      </div>

      <div className={styles.memberDetails}>
        <p className={styles.memberName}>
          <span className={styles.memberNameText}>{member.name}</span>
          {isInactiveMember(member.status) && (
            <span className={styles.statusBadge}>{memberStatusLabel(member.status, member.statusSource ?? null)}</span>
          )}
        </p>
        {member.roles.length > 0 && (
          <div className={`${styles.badgeRow} ${styles.roleRow}`}>
            {member.roles.map((r) => (
              <span key={r} className={styles.badge} style={roleTone(r)}>
                {r}
              </span>
            ))}
          </div>
        )}
        {member.tags.length > 0 && (
          <div className={`${styles.badgeRow} ${styles.tagRow}`}>
            {member.tags.map((t) => (
              <span key={t} className={`${styles.badge} ${styles.tagBadge}`}>
                {t}
              </span>
            ))}
          </div>
        )}
        {member.email && (
          <p className={styles.email} title={member.email}>
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
    <div className={styles.page}>
      <div className={styles.panel}>
        {sorted.length === 0 ? (
          <div className={styles.emptyState}>
            <p>暂无人员</p>
          </div>
        ) : (
          <div className={styles.memberGrid}>
            {sorted.map((m) => (
              <MemberCard key={m.userId} member={m} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
