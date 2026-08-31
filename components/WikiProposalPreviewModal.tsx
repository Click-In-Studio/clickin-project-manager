"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import WikiMarkdown from "@/components/wiki/WikiMarkdown";
import AccessRequestModal from "@/components/AccessRequestModal";

type ProposalAction = "create" | "update" | "delete" | "move" | "tag";

type ProposalPreview = {
  action: ProposalAction;
  targetWikiId: string | null;
  targetTitle: string | null;
  targetBody: string | null;
  targetTags: string[] | null;
  parentTitle: string | null;
  title: string | null;
  body: string;
  tags: string[] | null;
  summary: string;
  hasPermission: boolean;
  permissionKey: string;
  status: "pending" | "applied" | "blocked_no_permission" | "blocked_business_rule" | "rejected";
};

const ACTION_LABEL: Record<ProposalAction, string> = {
  create: "新建文档", update: "修改文档", delete: "删除文档", move: "移动文档", tag: "设置标签",
};
// 权限键动词——create 是"在该项目新建文档"（域级），其余是对准具体这一篇
// 文档的"编辑/删除"（实例级），措辞要对得上 AccessRequestModal 里
// permission prop 锁定的那把键，不能一刀切写"新建"。
const ACTION_PERMISSION_VERB: Record<ProposalAction, string> = {
  create: "在该项目新建文档", update: "编辑这篇文档", delete: "删除这篇文档",
  move: "编辑这篇文档（移动也算编辑）", tag: "编辑这篇文档（设置标签也算编辑）",
};

// 剧本写提议（/api/agent/script-proposal）：逐块 diff 概要在 notes 里，
// 方言全文/精修参数原样展示——权限三态行（🔓📝⛔）自带申请入口说明。
type ScriptProposalPreview = {
  kind: "rewrite" | "edit_blocks";
  summary: string;
  sectionId: string | null;
  dialect: string | null;
  updates: Array<Record<string, unknown>>;
  inserts: Array<Record<string, unknown>>;
  deletes: string[];
  hasPermission: boolean;
  notes: string[];
  error: string | null;
};

const SCRIPT_KIND_LABEL: Record<ScriptProposalPreview["kind"], string> = {
  rewrite: "改写剧本段落", edit_blocks: "修改剧本正文",
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
  const [scriptData, setScriptData] = useState<ScriptProposalPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [notFound, setNotFound] = useState(false);
  const [accessModalOpen, setAccessModalOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setLoading(true);
    setNotFound(false);
    setData(null);
    setScriptData(null);
    // 按钮对所有 approval 常显（省一次预探测），modal 自己按提议类型路由：
    // 先试 wiki 提议（有预持久化行），404 再试剧本写提议（agent_approval.args 现算），
    // 都没有才是真空态。
    (async () => {
      const wiki = await fetch(`/api/agent/wiki-proposal?toolCallId=${encodeURIComponent(toolCallId)}&productionId=${encodeURIComponent(productionId)}`);
      if (!alive) return;
      if (wiki.ok) { setData(await wiki.json()); return; }
      const script = await fetch(`/api/agent/script-proposal?toolCallId=${encodeURIComponent(toolCallId)}&productionId=${encodeURIComponent(productionId)}`);
      if (!alive) return;
      if (script.ok) { setScriptData(await script.json()); return; }
      setNotFound(true);
    })()
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
                {data ? ACTION_LABEL[data.action] : scriptData ? SCRIPT_KIND_LABEL[scriptData.kind] : "提议详情"}
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
              <p style={{ fontSize: 13, color: "var(--muted)" }}>没有找到对应的提议详情（可能已过期，或该类操作暂不支持详情预览）。</p>
            )}
            {!loading && scriptData && (
              <>
                {scriptData.summary && <p style={{ fontSize: 13, color: "var(--muted)", margin: "0 0 12px" }}>{scriptData.summary}</p>}
                {scriptData.error && (
                  <div style={{ margin: "0 0 14px", padding: "10px 14px", background: "var(--warn-soft)", border: "1px solid var(--warn)", borderRadius: 10 }}>
                    <p style={{ margin: 0, fontSize: 12, color: "var(--warn)" }}>
                      按当前剧本状态重新规划失败（卡片弹出后剧本可能已被修改）：{scriptData.error}
                    </p>
                  </div>
                )}
                {!scriptData.error && !scriptData.hasPermission && (
                  <div style={{ margin: "0 0 14px", padding: "10px 14px", background: "var(--warn-soft)", border: "1px solid var(--warn)", borderRadius: 10 }}>
                    <p style={{ margin: 0, fontSize: 12, color: "var(--warn)" }}>
                      你目前缺少部分权限——批准后调用会被拦截、不会真的生效。缺哪几把钥匙见下方清单（📝 行含申请入口）。
                    </p>
                  </div>
                )}
                {scriptData.notes.length > 0 && (
                  <ul style={{ margin: "0 0 14px", paddingLeft: 18, fontSize: 13, color: "var(--ink)", display: "grid", gap: 4 }}>
                    {scriptData.notes.map((n, i) => <li key={i} style={{ overflowWrap: "anywhere" }}>{n}</li>)}
                  </ul>
                )}
                {scriptData.kind === "rewrite" && scriptData.dialect && (
                  <div style={{ border: "1px solid var(--line)", borderRadius: 10, padding: "12px 14px" }}>
                    <p style={{ margin: "0 0 6px", fontSize: 11, color: "var(--muted)" }}>
                      提交的整段方言文本（[b:…] 为保留块、[new] 为新增、省略即删除）：
                    </p>
                    <pre style={{ margin: 0, fontSize: 12, lineHeight: 1.7, whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontFamily: "var(--font-mono, monospace)", maxHeight: 360, overflowY: "auto" }}>
                      {scriptData.dialect}
                    </pre>
                  </div>
                )}
                {scriptData.kind === "edit_blocks" && (
                  <div style={{ border: "1px solid var(--line)", borderRadius: 10, padding: "12px 14px", fontSize: 12, color: "var(--ink)", display: "grid", gap: 6 }}>
                    {scriptData.updates.map((u, i) => (
                      <div key={`u${i}`} style={{ overflowWrap: "anywhere" }}>
                        改 [{String(u.blockId ?? "")}]：{Object.entries(u).filter(([k]) => k !== "blockId").map(([k, v]) => `${k}=${JSON.stringify(v)}`).join("；")}
                      </div>
                    ))}
                    {scriptData.inserts.map((it, i) => (
                      <div key={`i${i}`} style={{ overflowWrap: "anywhere" }}>
                        增（在 [{String(it.afterBlockId ?? "")}] 之后）：{String(it.content ?? "")}
                      </div>
                    ))}
                    {scriptData.deletes.map((id, i) => (
                      <div key={`d${i}`} style={{ overflowWrap: "anywhere" }}>删 [{id}]</div>
                    ))}
                  </div>
                )}
              </>
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
                {data.action === "tag" && (
                  <>
                    <p style={{ fontSize: 12, color: "var(--muted)", margin: "0 0 4px" }}>正在设置标签</p>
                    <h3 style={{ fontSize: 18, fontWeight: 700, color: "var(--ink)", margin: "0 0 4px" }}>
                      《{data.targetTitle ?? "（你看不到这篇文档的当前内容）"}》
                    </h3>
                    <p style={{ fontSize: 13, color: "var(--muted)", margin: "0 0 4px" }}>
                      旧标签：{data.targetTags && data.targetTags.length > 0 ? data.targetTags.join("、") : "（无）"}
                    </p>
                    <p style={{ fontSize: 13, color: "var(--ink)", margin: "0 0 4px" }}>
                      新标签（整体替换）：{data.tags && data.tags.length > 0 ? data.tags.join("、") : "（清空）"}
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
