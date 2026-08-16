"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import WikiMarkdown from "@/components/wiki/WikiMarkdown";
import AccessRequestModal from "@/components/AccessRequestModal";

type ProposalAction = "create" | "update" | "delete" | "move";

type ProposalPreview = {
  action: ProposalAction;
  targetWikiId: string | null;
  targetTitle: string | null;
  targetBody: string | null;
  parentTitle: string | null;
  title: string | null;
  body: string;
  summary: string;
  hasPermission: boolean;
  permissionKey: string;
  status: "pending" | "applied" | "blocked_no_permission" | "blocked_business_rule" | "rejected";
};

const ACTION_LABEL: Record<ProposalAction, string> = {
  create: "新建文档", update: "修改文档", delete: "删除文档", move: "移动文档",
};
// 权限键动词——create 是"在该项目新建文档"（域级），其余三个是对准
// 具体这一篇文档的"编辑/删除"（实例级），措辞要对得上 AccessRequestModal
// 里 permission prop 锁定的那把键，不能一刀切写"新建"。
const ACTION_PERMISSION_VERB: Record<ProposalAction, string> = {
  create: "在该项目新建文档", update: "编辑这篇文档", delete: "删除这篇文档", move: "编辑这篇文档（移动也算编辑）",
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
  // 传送到 document.body：AgentPopout 面板本身带 CSS transform（滑入动画）
  // 会成为 fixed 定位子孙的 containing block，不传送的话这个 modal 会被
  // 摁在 popout 那 440px 宽的面板里，而不是盖住整个页面。
  if (typeof document === "undefined") return null;

  return createPortal(
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
                {data ? ACTION_LABEL[data.action] : "文档操作"}
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
                {data.action === "create" && (
                  <>
                    <p style={{ fontSize: 12, color: "var(--muted)", margin: "0 0 4px" }}>
                      位置：{data.parentTitle ? `《${data.parentTitle}》下` : "文档库根"}
                    </p>
                    <h3 style={{ fontSize: 18, fontWeight: 700, color: "var(--ink)", margin: "0 0 4px" }}>《{data.title}》</h3>
                  </>
                )}
                {data.action === "update" && (
                  <>
                    <p style={{ fontSize: 12, color: "var(--muted)", margin: "0 0 4px" }}>正在修改</p>
                    <h3 style={{ fontSize: 18, fontWeight: 700, color: "var(--ink)", margin: "0 0 4px" }}>
                      《{data.targetTitle ?? "（你看不到这篇文档的当前内容）"}》
                    </h3>
                    {data.title && data.title !== data.targetTitle && (
                      <p style={{ fontSize: 13, color: "var(--ink)", margin: "0 0 4px" }}>新标题：《{data.title}》</p>
                    )}
                  </>
                )}
                {data.action === "delete" && (
                  <>
                    <p style={{ fontSize: 12, color: "var(--danger)", margin: "0 0 4px" }}>将被删除</p>
                    <h3 style={{ fontSize: 18, fontWeight: 700, color: "var(--ink)", margin: "0 0 4px" }}>
                      《{data.targetTitle ?? "（你看不到这篇文档的当前内容）"}》
                    </h3>
                  </>
                )}
                {data.action === "move" && (
                  <>
                    <p style={{ fontSize: 12, color: "var(--muted)", margin: "0 0 4px" }}>正在移动</p>
                    <h3 style={{ fontSize: 18, fontWeight: 700, color: "var(--ink)", margin: "0 0 4px" }}>
                      《{data.targetTitle ?? "（你看不到这篇文档的当前内容）"}》
                    </h3>
                    <p style={{ fontSize: 13, color: "var(--ink)", margin: "0 0 4px" }}>
                      新位置：{data.parentTitle ? `《${data.parentTitle}》下` : "文档库根"}
                    </p>
                  </>
                )}

                {data.summary && <p style={{ fontSize: 13, color: "var(--muted)", margin: "0 0 14px" }}>{data.summary}</p>}

                {data.status === "blocked_business_rule" && (
                  <div style={{ margin: "0 0 14px", padding: "10px 14px", background: "var(--warn-soft)", border: "1px solid var(--warn)", borderRadius: 10 }}>
                    <p style={{ margin: 0, fontSize: 12, color: "var(--warn)" }}>
                      这个操作被业务规则拦下了（比如文档被报告/备注引用、或是系统锚点目录），不是权限问题——申请权限也解决不了，需要先解除挂载/换一篇文档。
                    </p>
                  </div>
                )}

                {data.status !== "blocked_business_rule" && !data.hasPermission && (
                  <div style={{ margin: "0 0 14px", padding: "10px 14px", background: "var(--warn-soft)", border: "1px solid var(--warn)", borderRadius: 10 }}>
                    <p style={{ margin: "0 0 8px", fontSize: 12, color: "var(--warn)" }}>
                      你目前没有{ACTION_PERMISSION_VERB[data.action]}的权限——批准后调用会被拦截，不会真的生效。
                    </p>
                    <button
                      onClick={() => setAccessModalOpen(true)}
                      style={{ padding: "6px 14px", borderRadius: 8, border: "none", background: "var(--ink)", color: "var(--paper)", fontSize: 12, fontWeight: 600, cursor: "pointer" }}
                    >
                      去申请权限
                    </button>
                  </div>
                )}

                {(data.action === "create" || (data.action === "update" && data.body)) && (
                  <div style={{ border: "1px solid var(--line)", borderRadius: 10, padding: "14px 16px" }}>
                    <WikiMarkdown content={data.body || "（空）"} productionId={productionId} />
                  </div>
                )}
                {data.action === "update" && !data.body && (
                  <p style={{ fontSize: 13, color: "var(--muted)" }}>正文不变。</p>
                )}
                {data.action === "delete" && data.targetBody && (
                  <div style={{ border: "1px solid var(--line)", borderRadius: 10, padding: "14px 16px", opacity: 0.7 }}>
                    <WikiMarkdown content={data.targetBody} productionId={productionId} />
                  </div>
                )}
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
          initialNote={`AI 调用「${ACTION_LABEL[data.action]}」功能需要此权限。提议内容：` +
            (data.action === "create"
              ? `《${data.title}》${data.parentTitle ? `（挂在《${data.parentTitle}》下）` : ""}。`
              : `《${data.targetTitle ?? data.targetWikiId}》。`)}
        />
      )}
    </>,
    document.body,
  );
}
