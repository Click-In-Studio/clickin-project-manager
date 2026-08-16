"use client";

import { useEffect, useState } from "react";
import WikiMarkdown from "@/components/wiki/WikiMarkdown";
import AccessRequestModal from "@/components/AccessRequestModal";

type ProposalPreview = {
  parentTitle: string | null;
  title: string;
  body: string;
  summary: string;
  hasPermission: boolean;
  permissionKey: string;
  status: "pending" | "applied" | "blocked_no_permission" | "rejected";
};

// AI propose 的完整预览——聊天栏确认卡片 description 硬上限 512 字符装不下
// 全文，点「查看详情」弹这个 modal 按 toolCallId 拉取全量内容。不是所有
// approval 气泡都对应一个 wiki proposal（未来会有别的写工具），找不到就
// 展示空态而不是报错——见 AgentPopout 里"始终渲染按钮，modal 自己兜底"。
export default function WikiProposalPreviewModal({
  open,
  onClose,
  productionId,
  toolCallId,
}: {
  open: boolean;
  onClose: () => void;
  productionId: string;
  toolCallId: string;
}) {
  const [data, setData] = useState<ProposalPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [notFound, setNotFound] = useState(false);
  const [accessModalOpen, setAccessModalOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setLoading(true);
    setNotFound(false);
    setData(null);
    fetch(`/api/agent/wiki-proposal?toolCallId=${encodeURIComponent(toolCallId)}&productionId=${encodeURIComponent(productionId)}`)
      .then(async (res) => {
        if (!alive) return;
        if (!res.ok) { setNotFound(true); return; }
        setData(await res.json());
      })
      .catch(() => { if (alive) setNotFound(true); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [open, toolCallId, productionId]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <>
      <div
        role="presentation"
        style={{
          position: "fixed", inset: 0, zIndex: 300,
          background: "rgba(0,0,0,.45)",
          display: "flex", alignItems: "center", justifyContent: "center",
          padding: "0 16px",
        }}
        onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      >
        <section
          role="dialog"
          aria-modal="true"
          aria-labelledby="wiki-proposal-title"
          style={{
            width: "min(640px, 100%)", maxHeight: "85vh",
            display: "flex", flexDirection: "column",
            background: "var(--surface)", borderRadius: 16,
            boxShadow: "0 24px 80px rgba(24,42,42,.22)", overflow: "hidden",
          }}
        >
          <div style={{
            padding: "20px 24px", borderBottom: "1px solid var(--line)",
            display: "flex", alignItems: "flex-start", justifyContent: "space-between", flexShrink: 0,
          }}>
            <div>
              <p style={{ margin: "0 0 3px", fontSize: 9, fontWeight: 700, letterSpacing: ".14em", textTransform: "uppercase", color: "var(--muted)" }}>
                AI 提议预览
              </p>
              <h2 id="wiki-proposal-title" style={{ margin: 0, fontSize: 16, fontWeight: 600, color: "var(--ink)" }}>
                新建文档
              </h2>
            </div>
            <button
              onClick={onClose}
              aria-label="关闭"
              style={{ background: "none", border: "none", cursor: "pointer", color: "var(--muted)", fontSize: 18, lineHeight: 1, padding: 4 }}
            >
              ✕
            </button>
          </div>

          <div style={{ padding: "18px 24px", overflowY: "auto", flex: 1 }}>
            {loading && <p style={{ fontSize: 13, color: "var(--muted)" }}>加载中…</p>}
            {!loading && notFound && (
              <p style={{ fontSize: 13, color: "var(--muted)" }}>没有找到对应的提议详情（可能不是文档相关的确认请求，或已过期）。</p>
            )}
            {!loading && data && (
              <>
                <p style={{ fontSize: 12, color: "var(--muted)", margin: "0 0 4px" }}>
                  位置：{data.parentTitle ? `《${data.parentTitle}》下` : "文档库根"}
                </p>
                <h3 style={{ fontSize: 18, fontWeight: 700, color: "var(--ink)", margin: "0 0 4px" }}>《{data.title}》</h3>
                {data.summary && <p style={{ fontSize: 13, color: "var(--muted)", margin: "0 0 14px" }}>{data.summary}</p>}

                {!data.hasPermission && (
                  <div style={{ margin: "0 0 14px", padding: "10px 14px", background: "var(--warn-soft)", border: "1px solid var(--warn)", borderRadius: 10 }}>
                    <p style={{ margin: "0 0 8px", fontSize: 12, color: "var(--warn)" }}>
                      你目前没有在该项目新建文档的权限——批准后调用会被拦截，不会真的创建。
                    </p>
                    <button
                      onClick={() => setAccessModalOpen(true)}
                      style={{ padding: "6px 14px", borderRadius: 8, border: "none", background: "var(--ink)", color: "var(--paper)", fontSize: 12, fontWeight: 600, cursor: "pointer" }}
                    >
                      去申请权限
                    </button>
                  </div>
                )}

                <div style={{ border: "1px solid var(--line)", borderRadius: 10, padding: "14px 16px" }}>
                  <WikiMarkdown content={data.body || "（空）"} productionId={productionId} />
                </div>
              </>
            )}
          </div>
        </section>
      </div>

      {data && (
        <AccessRequestModal
          open={accessModalOpen}
          onClose={() => setAccessModalOpen(false)}
          productionId={productionId}
          permission={data.permissionKey}
          initialNote={`AI 调用「新建文档」功能需要此权限。提议内容：《${data.title}》${data.parentTitle ? `（挂在《${data.parentTitle}》下）` : ""}。`}
        />
      )}
    </>
  );
}
