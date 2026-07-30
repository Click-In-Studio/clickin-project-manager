"use client";

import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import type { MyProductionEntry } from "@/lib/db";
import { BASE_PATH } from "@/lib/base-path";
import styles from "@/components/my-pages.module.css";

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

export default function MyProjectsClient() {
  const router = useRouter();
  const [projects, setProjects] = useState<MyProductionEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [roleFilter, setRoleFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<"active" | "archived" | "all">("active");
  const [creating, setCreating] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState("");
  const [createError, setCreateError] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    fetch(`${BASE_PATH}/api/my/projects`)
      .then(r => r.json())
      .then((data: MyProductionEntry[]) => { setProjects(data); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (showCreate) inputRef.current?.focus();
  }, [showCreate]);

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

  async function createProject() {
    if (!newName.trim() || creating) return;
    setCreating(true);
    setCreateError("");
    try {
      const res = await fetch(`${BASE_PATH}/api/productions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({ name: newName.trim() }),
      });
      const data = await res.json();
      if (!res.ok) { setCreateError(data.error ?? "创建失败"); return; }
      router.push(`/production/${data.id}`);
    } catch {
      setCreateError("网络错误，请重试");
    } finally {
      setCreating(false);
    }
  }

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
      </div>

      {/* Create project inline form */}
      {showCreate && (
        <div style={{
          background: "var(--surface)", border: "1px solid var(--line)", borderRadius: 12,
          padding: "20px 24px", marginBottom: 20,
        }}>
          <p style={{ margin: "0 0 12px", fontSize: 13, fontWeight: 700, color: "var(--ink)" }}>新建项目</p>
          <div style={{ display: "flex", gap: 10, alignItems: "flex-start", flexWrap: "wrap" }}>
            <input
              ref={inputRef}
              value={newName}
              onChange={e => { setNewName(e.target.value); setCreateError(""); }}
              onKeyDown={e => e.key === "Enter" && createProject()}
              placeholder="输入项目名称"
              style={{
                flex: 1, minWidth: 220, border: "1px solid var(--line)", borderRadius: 8,
                padding: "10px 14px", fontSize: 13, color: "var(--ink)",
                background: "var(--paper)", outline: "none",
              }}
            />
            <button
              onClick={createProject}
              disabled={!newName.trim() || creating}
              style={{
                border: "1px solid var(--ink)", borderRadius: 8, padding: "10px 20px",
                background: "var(--ink)", color: "#fff",
                fontSize: 12, fontWeight: 700, cursor: "pointer",
                opacity: !newName.trim() || creating ? 0.4 : 1,
              }}
            >
              {creating ? "创建中…" : "创建"}
            </button>
            <button
              onClick={() => { setShowCreate(false); setNewName(""); setCreateError(""); }}
              style={{
                border: "1px solid var(--line)", borderRadius: 8, padding: "10px 16px",
                background: "transparent", color: "var(--muted)",
                fontSize: 12, cursor: "pointer",
              }}
            >
              取消
            </button>
          </div>
          {createError && <p style={{ margin: "8px 0 0", fontSize: 11, color: "var(--danger)" }}>{createError}</p>}
        </div>
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
          <select
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
          </select>
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

              <p style={{ margin: 0, fontSize: 10, color: "var(--muted)" }}>
                创建于 {fmtDate(p.createdAt)}
              </p>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
