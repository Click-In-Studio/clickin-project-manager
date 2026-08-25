"use client";

import OverflowSafeSelect from "@/components/OverflowSafeSelect";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import type { MyProductionEntry } from "@/lib/db";
import { BASE_PATH } from "@/lib/base-path";
import styles from "@/components/my-pages.module.css";
import NewProductionModal from "@/components/NewProductionModal";

function fmtDate(iso: string) {
  const d = new Date(iso);
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}`;
}

function ProductionAvatar({ productionId, name }: { productionId: string; name: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) return <>{name.charAt(0)}</>;
  return (
    <img
      src={`${BASE_PATH}/api/production/${productionId}/avatar`}
      alt={name}
      style={{ width: "100%", height: "100%", objectFit: "cover" }}
      onError={() => setFailed(true)}
    />
  );
}

/** canCreate = 用户等级（付费维度）允许建项目。权限维度不参与——见 app/layout.tsx 注释。 */
export default function MyProjectsClient(
  { canCreate = false, currentUserId }: { canCreate?: boolean; currentUserId: string },
) {
  const router = useRouter();
  const [projects, setProjects] = useState<MyProductionEntry[]>([]);
  const [exiting, setExiting] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [roleFilter, setRoleFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<"active" | "archived" | "all">("active");
  const [showCreate, setShowCreate] = useState(false);

  useEffect(() => {
    fetch(`${BASE_PATH}/api/my/projects`)
      .then(r => r.json())
      .then((data: MyProductionEntry[]) => { setProjects(data); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  /**
   * 自助退出（#141）。退出即生效——访问权当场归零，不等任何人批准。
   * 只是「撤回我的访问权」，不是解除职务、更不抹掉已完成的工作记录与署名，
   * 所以确认文案必须把这件事说清楚，别让它读起来像「删除我的贡献」。
   * owner 不显示此入口：他没有上级也没人能处置他，要走得先转移 owner。
   */
  async function exitProject(p: MyProductionEntry) {
    if (!confirm(
      `退出《${p.name}》？\n\n` +
      "你将不再接收该项目的通知，也无法访问其内容。\n" +
      "已完成的工作记录与署名不受影响。\n\n" +
      "退出会通知项目负责人；如需回来，请联系他们恢复。",
    )) return;
    setExiting(p.id);
    try {
      const res = await fetch(
        `${BASE_PATH}/api/production/${p.id}/members/${currentUserId}/status`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "self_exit" }),
        },
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.error) { alert(data.error ?? "退出失败"); return; }
      setProjects(prev => prev.filter(x => x.id !== p.id));
    } catch {
      alert("网络错误");
    } finally {
      setExiting(null);
    }
  }

  const allRoles = Array.from(new Set(projects.flatMap(p => p.roles))).sort();

  const filtered = projects.filter(p => {
    if (statusFilter === "active" && p.archivedAt) return false;
    if (statusFilter === "archived" && !p.archivedAt) return false;
    if (search && !p.name.toLowerCase().includes(search.toLowerCase())) return false;
    if (roleFilter !== "all" && !p.roles.includes(roleFilter)) return false;
    return true;
  });

  const activeCount = projects.filter(p => !p.archivedAt).length;
  const archivedCount = projects.filter(p => p.archivedAt).length;

  if (loading) {
    return (
      <div className={styles.workspace}>
        <div className={styles.pageHeader}>
          <p className={styles.eyebrow}>Platform · 项目</p>
          <h1 className={styles.pageTitle}>我的项目</h1>
        </div>
        <div className={styles.emptyState}>加载中…</div>
      </div>
    );
  }

  return (
    <div className={styles.workspace}>
      {/* Header row */}
      <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", marginBottom: 28, gap: 16, flexWrap: "wrap" }}>
        <div className={styles.pageHeader} style={{ margin: 0 }}>
          <p className={styles.eyebrow}>Platform · 项目</p>
          <h1 className={styles.pageTitle}>我的项目</h1>
        </div>
        {canCreate && (
          <button
            onClick={() => setShowCreate(true)}
            style={{
              border: "1px solid var(--ink)", borderRadius: 9, padding: "10px 20px",
              background: "var(--ink)", color: "#fff",
              fontSize: 13, fontWeight: 700, cursor: "pointer", whiteSpace: "nowrap",
            }}
          >
            + 新建项目
          </button>
        )}
      </div>

      {showCreate && (
        <NewProductionModal
          onClose={() => setShowCreate(false)}
          onCreated={id => router.push(`/production/${id}`)}
        />
      )}

      {/* Toolbar: search + filters */}
      <div style={{ display: "flex", gap: 10, marginBottom: 20, flexWrap: "wrap", alignItems: "center" }}>
        {/* Search */}
        <div style={{ position: "relative", flex: "1 1 200px", maxWidth: 340 }}>
          <span style={{
            position: "absolute", left: 12, top: "50%", transform: "translateY(-50%)",
            fontSize: 12, color: "var(--muted)", pointerEvents: "none",
          }}>
            ⌕
          </span>
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="搜索项目名称…"
            style={{
              width: "100%", border: "1px solid var(--line)", borderRadius: 8,
              padding: "9px 12px 9px 30px", fontSize: 13, color: "var(--ink)",
              background: "var(--surface)", outline: "none", boxSizing: "border-box",
            }}
          />
        </div>

        {/* Status filter */}
        <div style={{ display: "flex", gap: 2, background: "var(--surface-2)", borderRadius: 8, padding: 3 }}>
          {([["active", `进行中 (${activeCount})`], ["archived", `已归档 (${archivedCount})`], ["all", "全部"]] as const).map(([v, label]) => (
            <button key={v} onClick={() => setStatusFilter(v)} style={{
              border: 0, borderRadius: 6, padding: "6px 12px",
              fontSize: 11, fontWeight: 700, cursor: "pointer",
              background: statusFilter === v ? "var(--ink)" : "transparent",
              color: statusFilter === v ? "#fff" : "var(--muted)",
            }}>
              {label}
            </button>
          ))}
        </div>

        {/* Role filter */}
        {allRoles.length > 0 && (
          <OverflowSafeSelect
            value={roleFilter}
            onChange={e => setRoleFilter(e.target.value)}
            style={{
              border: "1px solid var(--line)", borderRadius: 8, padding: "8px 12px",
              fontSize: 12, color: "var(--ink)", background: "var(--surface)",
              outline: "none", cursor: "pointer",
            }}
          >
            <option value="all">所有角色</option>
            {allRoles.map(r => <option key={r} value={r}>{r}</option>)}
          </OverflowSafeSelect>
        )}
      </div>

      {/* Project grid */}
      {filtered.length === 0 ? (
        <div className={styles.emptyState} style={{ paddingTop: 60 }}>
          {search || roleFilter !== "all" ? "无匹配项目" : statusFilter === "archived" ? "暂无已归档项目" : "暂无进行中项目"}
          <small>{search && "尝试调整搜索关键词"}</small>
        </div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 14 }}>
          {filtered.map(p => (
            <button
              key={p.id}
              onClick={() => router.push(`/production/${p.id}`)}
              style={{
                border: "1px solid var(--line)", borderRadius: 12,
                padding: "20px 22px", background: "var(--surface)",
                cursor: "pointer", textAlign: "left",
                transition: "border-color .15s, box-shadow .15s",
                display: "flex", flexDirection: "column", gap: 10,
                opacity: p.archivedAt ? 0.6 : 1,
              }}
              onMouseEnter={e => {
                (e.currentTarget as HTMLElement).style.borderColor = "var(--ink)";
                (e.currentTarget as HTMLElement).style.boxShadow = "0 2px 8px rgba(0,0,0,.06)";
              }}
              onMouseLeave={e => {
                (e.currentTarget as HTMLElement).style.borderColor = "var(--line)";
                (e.currentTarget as HTMLElement).style.boxShadow = "none";
              }}
            >
              <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
                <div style={{
                  width: 36, height: 36, borderRadius: 9, background: "var(--ink)",
                  color: "#fff", fontSize: 13, fontWeight: 700,
                  display: "flex", alignItems: "center", justifyContent: "center",
                  flexShrink: 0, letterSpacing: "-.02em", overflow: "hidden",
                }}>
                  {p.avatarUrl ? (
                    <ProductionAvatar productionId={p.id} name={p.name} />
                  ) : (
                    p.name.charAt(0)
                  )}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <p style={{ margin: 0, fontSize: 14, fontWeight: 700, color: "var(--ink)", lineHeight: 1.3 }}>
                    {p.name}
                  </p>
                  {p.archivedAt && (
                    <span style={{
                      display: "inline-block", marginTop: 3,
                      fontSize: 9, fontWeight: 700, letterSpacing: ".1em",
                      textTransform: "uppercase", color: "var(--muted)",
                      background: "var(--surface-2)", borderRadius: 4, padding: "2px 6px",
                    }}>已归档</span>
                  )}
                </div>
              </div>

              {p.roles.length > 0 && (
                <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
                  {p.roles.map(r => (
                    <span key={r} style={{
                      fontSize: 10, fontWeight: 600, padding: "3px 8px", borderRadius: 5,
                      background: "var(--surface-2)", color: "var(--script)",
                    }}>
                      {r}
                    </span>
                  ))}
                </div>
              )}

              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <p style={{ margin: 0, fontSize: 10, color: "var(--muted)" }}>
                  创建于 {fmtDate(p.createdAt)}
                </p>
                {/* 卡片本身是 <button>，退出入口不能再套一层 button（HTML 不允许嵌套） */}
                {!p.isOwner && !p.archivedAt && (
                  <span
                    role="button"
                    tabIndex={0}
                    aria-disabled={exiting === p.id}
                    onClick={e => { e.stopPropagation(); if (exiting !== p.id) void exitProject(p); }}
                    onKeyDown={e => {
                      if (e.key !== "Enter" && e.key !== " ") return;
                      e.preventDefault(); e.stopPropagation();
                      if (exiting !== p.id) void exitProject(p);
                    }}
                    style={{
                      marginLeft: "auto", fontSize: 10, color: "var(--muted)",
                      textDecoration: "underline", cursor: "pointer",
                      opacity: exiting === p.id ? 0.5 : 1,
                    }}
                  >
                    {exiting === p.id ? "退出中…" : "退出项目"}
                  </span>
                )}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
