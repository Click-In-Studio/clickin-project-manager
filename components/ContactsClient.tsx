"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { BASE_PATH } from "@/lib/base-path";
import type { MemberWithRoles } from "@/lib/db";
import { ROLE_GROUPS } from "@/lib/roles";

// Ordered list of all role labels for sorting members in the face page.
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
  // Feishu file tokens don't start with https — proxy them through /api/media.
  if (raw.startsWith("http")) return raw;
  return `${BASE_PATH}/api/media?token=${encodeURIComponent(raw)}`;
}

function MemberCard({ member }: { member: MemberWithRoles }) {
  const photo = resolvePhoto(member.photoUrl) ?? member.avatarUrl;

  return (
    <div className="rounded-2xl bg-white shadow-sm overflow-hidden flex flex-col">
      {/* Photo */}
      <div className="aspect-[3/4] bg-zinc-100 flex items-center justify-center overflow-hidden">
        {photo ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={photo} alt={member.name} className="w-full h-full object-cover" />
        ) : (
          <span className="text-3xl font-medium text-zinc-300">{member.name[0]}</span>
        )}
      </div>

      {/* Info */}
      <div className="px-3 py-3 flex flex-col gap-1.5">
        <p className="text-sm font-semibold text-zinc-800">{member.name}</p>

        {member.roles.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {member.roles.map((r) => (
              <span
                key={r}
                className="rounded-full bg-zinc-100 px-2 py-0.5 text-[11px] text-zinc-500"
              >
                {r}
              </span>
            ))}
          </div>
        )}

        {member.email && (
          <a
            href={`mailto:${member.email}`}
            className="text-xs text-zinc-400 hover:text-zinc-600 truncate"
          >
            {member.email}
          </a>
        )}
        {member.phone && (
          <a
            href={`tel:${member.phone}`}
            className="text-xs text-zinc-400 hover:text-zinc-600"
          >
            {member.phone}
          </a>
        )}
      </div>
    </div>
  );
}

// ─── ImportPanel ──────────────────────────────────────────────────────────────

function ImportPanel({
  productionId,
  onImported,
}: {
  productionId: string;
  onImported: (members: MemberWithRoles[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [wikiUrl, setWikiUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<{
    ok?: boolean;
    stats?: { matched: number; created: number; notFound: string[] };
    warnings?: string[];
    error?: string;
    details?: string[];
  } | null>(null);

  const submit = async () => {
    if (!wikiUrl.trim()) return;
    setLoading(true);
    setResult(null);
    try {
      const res = await fetch(
        `${BASE_PATH}/api/production/${productionId}/import-contacts`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ wikiUrl: wikiUrl.trim() }),
        }
      );
      const data = await res.json();
      setResult(data);
      if (data.ok) {
        // Reload members from server.
        const r2 = await fetch(`${BASE_PATH}/api/production/${productionId}/contacts`);
        if (r2.ok) onImported(await r2.json());
      }
    } catch {
      setResult({ error: "网络错误，请重试" });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="rounded-2xl bg-white shadow-sm overflow-hidden mb-6">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between px-5 py-4 text-sm font-medium text-zinc-700 hover:bg-zinc-50 transition-colors"
      >
        <span>导入 / 更新人员</span>
        <span className="text-zinc-300 text-base">{open ? "−" : "+"}</span>
      </button>

      {open && (
        <div className="px-5 pb-5 space-y-3 border-t border-zinc-100">
          <p className="pt-3 text-xs text-zinc-400">
            粘贴飞书 contact sheet 的 Wiki 链接，表格须包含「姓名」「职位」列。
          </p>
          <input
            value={wikiUrl}
            onChange={(e) => { setWikiUrl(e.target.value); setResult(null); }}
            onKeyDown={(e) => e.key === "Enter" && submit()}
            placeholder="https://xxx.feishu.cn/wiki/..."
            className="w-full rounded-lg border border-zinc-200 px-3 py-2 text-sm outline-none placeholder:text-zinc-300 focus:border-zinc-400"
          />
          <button
            onClick={submit}
            disabled={!wikiUrl.trim() || loading}
            className="w-full rounded-lg bg-zinc-800 py-2.5 text-sm font-medium text-white hover:bg-zinc-700 disabled:opacity-30"
          >
            {loading ? "导入中…" : "开始导入"}
          </button>

          {result && (
            <div className="rounded-lg border border-zinc-100 bg-zinc-50 px-3 py-2.5 space-y-1.5 text-xs">
              {result.error ? (
                <p className="text-red-500 font-medium">{result.error}</p>
              ) : (
                <p className="text-green-600 font-medium">
                  导入完成：匹配 {result.stats?.matched} 人，新增 {result.stats?.created} 人
                  {result.stats?.notFound.length
                    ? `，${result.stats.notFound.length} 人未找到`
                    : ""}
                </p>
              )}
              {result.stats?.notFound.length ? (
                <p className="text-zinc-400">未找到：{result.stats.notFound.join("、")}</p>
              ) : null}
              {result.details?.map((d, i) => <p key={i} className="text-zinc-400">{d}</p>)}
              {result.warnings?.map((w, i) => <p key={i} className="text-amber-500">{w}</p>)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── ContactsClient ───────────────────────────────────────────────────────────

type Props = {
  productionId: string;
  productionName: string;
  initialMembers: MemberWithRoles[];
  canManage: boolean;
};

export default function ContactsClient({
  productionId,
  productionName,
  initialMembers,
  canManage,
}: Props) {
  const [members, setMembers] = useState<MemberWithRoles[]>(initialMembers);
  const sorted = sortByFirstRole(members);

  return (
    <div className="min-h-screen bg-zinc-100 px-4 py-8">
      <div className="mx-auto max-w-3xl">
        {/* Header */}
        <div className="mb-6 flex items-center justify-between">
          <Link
            href={`/production/${productionId}`}
            className="text-xs text-zinc-400 hover:text-zinc-600 transition-colors"
          >
            ← 返回
          </Link>
          <div className="text-right">
            <p className="text-xs font-semibold tracking-widest text-zinc-300 uppercase">People</p>
            <p className="text-sm font-bold text-zinc-500">{productionName}</p>
          </div>
        </div>

        {/* Import panel (managers only) */}
        {canManage && (
          <ImportPanel productionId={productionId} onImported={setMembers} />
        )}

        {/* Face page grid */}
        {sorted.length === 0 ? (
          <p className="text-center text-sm text-zinc-300 py-16">暂无人员</p>
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
            {sorted.map((m) => (
              <MemberCard key={m.openId} member={m} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
