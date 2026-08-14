"use client";

import { useMemo, useState } from "react";
import PageHeader, { PRIMARY_BTN, SECONDARY_BTN } from "@/components/PageHeader";
import Badge from "@/components/Badge";
import PermissionKeyPicker, { type Vocabulary } from "@/components/PermissionKeyPicker";
import { BASE_PATH } from "@/lib/base-path";

import type { GovernanceGrantRow } from "@/lib/grant-audit-db";

type Member = { userId: string; name: string; roles: string[]; status: "active" | "suspended" };

type Props = {
  productionId: string;
  productionName: string;
  producerRole: { id: string; permissions: string[] } | null;
  members: Member[];
  initialGovernance: GovernanceGrantRow[];
  vocabulary: Vocabulary;
  isRoot: boolean;
};

const PRODUCER = "制作人";

const SECTION_LABEL: React.CSSProperties = {
  margin: "0 0 8px", fontSize: 10, fontWeight: 700, letterSpacing: ".1em",
  textTransform: "uppercase", color: "var(--stage)",
};

const CARD: React.CSSProperties = {
  background: "var(--surface)", border: "1px solid var(--line)", borderRadius: 13,
  padding: 22, marginBottom: 18,
};

export default function AdminProducerClient({
  productionId, productionName, producerRole, members: initialMembers, initialGovernance, vocabulary, isRoot,
}: Props) {
  const [members, setMembers] = useState<Member[]>(initialMembers);
  const [rolePerms, setRolePerms] = useState<string[]>(producerRole?.permissions ?? []);
  const [governance, setGovernance] = useState<GovernanceGrantRow[]>(initialGovernance);
  const [addUserId, setAddUserId] = useState("");
  const [govUserId, setGovUserId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const producers = useMemo(() => members.filter(m => m.roles.includes(PRODUCER)), [members]);
  const candidates = members.filter(m => !m.roles.includes(PRODUCER));
  const govVocabulary: Vocabulary = useMemo(() => ({
    verbs: Object.fromEntries(Object.entries(vocabulary.verbs).filter(([t]) => t === "production" || t === "producer")),
    subs: Object.fromEntries(Object.entries(vocabulary.subs).filter(([t]) => t === "production" || t === "producer")),
  }), [vocabulary]);

  async function api(path: string, init: RequestInit): Promise<Record<string, unknown> | null> {
    setBusy(true); setError(null);
    try {
      const res = await fetch(`${BASE_PATH}/api/production/${productionId}${path}`, {
        headers: { "Content-Type": "application/json" }, ...init,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.error) { setError(data.error ?? "操作失败"); return null; }
      return data;
    } catch { setError("网络错误"); return null; }
    finally { setBusy(false); }
  }

  async function toggleProducer(m: Member) {
    const has = m.roles.includes(PRODUCER);
    if (has && !confirm(`确认免去 ${m.name} 的制作人？其制作人自动授权将被撤销。`)) return;
    const nextRoles = has ? m.roles.filter(r => r !== PRODUCER) : [...m.roles, PRODUCER];
    if (await api(`/members`, { method: "PATCH", body: JSON.stringify({ userId: m.userId, roles: nextRoles }) })) {
      setMembers(prev => prev.map(x => (x.userId === m.userId ? { ...x, roles: nextRoles } : x)));
    }
  }

  async function saveRolePerms(keys: string[]) {
    if (!producerRole) return;
    const data = await api(`/roles/${producerRole.id}/permissions`, {
      method: "PUT", body: JSON.stringify({ permissions: keys }),
    });
    if (data) setRolePerms((data.permissions as string[]) ?? keys);
  }

  async function grantGov(userId: string, key: string) {
    const data = await api(`/governance-grants`, { method: "POST", body: JSON.stringify({ userId, key }) });
    if (data?.grantId) {
      const parsed = /^node:([a-z_]+)\/[^/@]+(?:\/([^@]+))?@(view|create|edit|delete)$/.exec(key);
      setGovernance(prev => [
        ...prev.filter(g => g.id !== data.grantId),
        {
          id: data.grantId as string,
          userId,
          userName: memberName(userId),
          resourceType: parsed?.[1] ?? "production",
          resourceSub: parsed?.[2] ?? "*",
          permissionLevel: parsed?.[3] ?? "view",
          createdAt: new Date().toISOString(),
        },
      ]);
    }
  }

  async function revokeGov(grantId: string) {
    if (await api(`/governance-grants`, { method: "DELETE", body: JSON.stringify({ grantId }) })) {
      setGovernance(prev => prev.filter(g => g.id !== grantId));
    }
  }

  const memberName = (userId: string) => members.find(m => m.userId === userId)?.name || userId.slice(0, 8);

  return (
    <div style={{ padding: "24px clamp(18px, 3vw, 52px) 60px", minHeight: "100vh", background: "var(--paper)" }}>
      <PageHeader eyebrow={productionName} title="管理员设置" side="stage" />

      {!isRoot && (
        <p style={{ margin: "0 0 14px", fontSize: 11, color: "var(--muted)", fontWeight: 700 }}>
          只读模式：管理员设置的变更（ROOT OPERATION）仅限项目所有者。
        </p>
      )}
      {error && <p style={{ margin: "0 0 10px", fontSize: 12, color: "var(--danger)", fontWeight: 700 }}>{error}</p>}

      {/* ── 制作人任免 ── */}
      <div style={CARD}>
        <p style={SECTION_LABEL}>制作人任免</p>
        <p style={{ margin: "0 0 12px", fontSize: 11, color: "var(--muted)", lineHeight: 1.6 }}>
          制作人是结构性系统角色：任命后按角色模版自动获得管理面授权（需本人自确认激活），免任时自动撤销。
        </p>
        {producers.map(m => (
          <div key={m.userId} style={{ display: "flex", alignItems: "center", gap: 9, padding: "6px 0", borderBottom: "1px solid var(--line)" }}>
            <span style={{ flex: 1, fontSize: 13, fontWeight: 600, color: "var(--ink)" }}>
              {m.name}
              {m.status === "suspended" && <Badge tone="red">已停用</Badge>}
            </span>
            {isRoot && (
              <button
                disabled={busy}
                onClick={() => toggleProducer(m)}
                style={{ ...SECONDARY_BTN, padding: "3px 9px", fontSize: 10, borderColor: "var(--danger)", color: "var(--danger)" }}
              >
                免任
              </button>
            )}
          </div>
        ))}
        {producers.length === 0 && <p style={{ fontSize: 12, color: "var(--muted)" }}>暂无制作人</p>}
        {isRoot && candidates.length > 0 && (
          <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
            <select
              value={addUserId} onChange={e => setAddUserId(e.target.value)}
              style={{ padding: "7px 10px", fontSize: 12, border: "1px solid var(--line)", borderRadius: 8, background: "var(--paper)", color: "var(--ink)", minWidth: 160 }}
            >
              <option value="">选择成员…</option>
              {candidates.map(m => <option key={m.userId} value={m.userId}>{m.name || m.userId.slice(0, 8)}</option>)}
            </select>
            <button
              style={PRIMARY_BTN} disabled={busy || !addUserId}
              onClick={async () => {
                const m = members.find(x => x.userId === addUserId);
                if (m) await toggleProducer(m);
                setAddUserId("");
              }}
            >
              任命为制作人
            </button>
          </div>
        )}
      </div>

      {/* ── 制作人权限集合 ── */}
      <div style={CARD}>
        <p style={SECTION_LABEL}>制作人权限集合（{rolePerms.length}）</p>
        <p style={{ margin: "0 0 12px", fontSize: 11, color: "var(--muted)", lineHeight: 1.6 }}>
          制作人角色的模版键集（通配区间宿主）。修改为 ROOT OPERATION；SENSITIVE/ROOT 治理键（手写三态清单）不经角色模版写入，保存时服务端过滤。
        </p>
        {rolePerms.map(k => (
          <div key={k} style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 0", borderBottom: "1px solid var(--line)" }}>
            <code style={{ flex: 1, fontSize: 11, color: "var(--ink)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{k}</code>
            {isRoot && (
              <button
                disabled={busy}
                onClick={() => saveRolePerms(rolePerms.filter(x => x !== k))}
                style={{ border: "none", background: "transparent", cursor: "pointer", color: "var(--muted)", fontSize: 13, padding: "2px 6px" }}
              >
                ×
              </button>
            )}
          </div>
        ))}
        {rolePerms.length === 0 && <p style={{ fontSize: 12, color: "var(--muted)" }}>空集</p>}
        {isRoot && producerRole && (
          <div style={{ marginTop: 12 }}>
            <PermissionKeyPicker
                          productionId={productionId}
              vocabulary={vocabulary} busy={busy}
              onAdd={key => { if (!rolePerms.includes(key)) saveRolePerms([...rolePerms, key]); }}
            />
          </div>
        )}
      </div>

      {/* ── 治理域授权 ── */}
      <div style={{ ...CARD, borderColor: "var(--stage)" }}>
        <p style={SECTION_LABEL}>治理域授权（{governance.length}）</p>
        <p style={{ margin: "0 0 12px", fontSize: 11, color: "var(--muted)", lineHeight: 1.6 }}>
          production / producer 为保留类型（通配不穿透）。此处直发 grant 行（direct，立即生效）——权限审计、数字资产审查等管理面入口的门票只能在此发放（仅限所有者），收回=手动撤销并入审计流水。
        </p>
        {governance.map(g => (
          <div key={g.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 0", borderBottom: "1px solid var(--line)" }}>
            <span style={{ fontSize: 12, fontWeight: 600, color: "var(--ink)", minWidth: 80 }}>{g.userName || memberName(g.userId)}</span>
            <code style={{ flex: 1, fontSize: 11, color: "var(--success)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {`node:${g.resourceType}/*${g.resourceSub !== "*" ? `/${g.resourceSub}` : ""}@${g.permissionLevel}`}
            </code>
            <Badge tone="green">生效中</Badge>
            {isRoot && (
              <button
                disabled={busy}
                onClick={() => revokeGov(g.id)}
                style={{ border: "none", background: "transparent", cursor: "pointer", color: "var(--muted)", fontSize: 13, padding: "2px 6px" }}
                title="收回（manual 撤销）"
              >
                ×
              </button>
            )}
          </div>
        ))}
        {governance.length === 0 && <p style={{ fontSize: 12, color: "var(--muted)" }}>未发放任何治理域资格</p>}
        {isRoot && (
          <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 8 }}>
            <select
              value={govUserId} onChange={e => setGovUserId(e.target.value)}
              style={{ padding: "7px 10px", fontSize: 12, border: "1px solid var(--line)", borderRadius: 8, background: "var(--paper)", color: "var(--ink)", width: 200 }}
            >
              <option value="">选择成员…</option>
              {members.map(m => <option key={m.userId} value={m.userId}>{m.name || m.userId.slice(0, 8)}</option>)}
            </select>
            {govUserId && (
              <PermissionKeyPicker
                          productionId={productionId}
                vocabulary={govVocabulary} busy={busy}
                onAdd={key => grantGov(govUserId, key)}
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
}
