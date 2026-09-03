"use client";

/**
 * 审批流程模版设计器（prC 接线版；UI 稿出自 #405）。
 *
 * 数据层：全部走服务端（prA 的 approval-flow-templates REST）——不再有
 * localStorage 草稿（跨项目串草稿、脏草稿崩溃两类问题随之消失）。
 * 「保存」落库为 draft；「发布」走 publish 端点，**引擎（prB）已生效**：
 * 发布后本项目新提交的资源申请按此流程流转，在途申请不受影响（快照定格）。
 *
 * 词表与校验与服务端同源（lib/approval-flow-template.ts）：多人策略 v1 仅或签
 * （渐进暴露，会签/依次待后续开放），cc 节点无超时，project_role/specific_members
 * 必须选到具体角色/成员才能保存。
 *
 * 本组件只在 owner 门内渲染（父组件按 canManageFlows 决定）；API 侧同一道门。
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import OverflowSafeSelect from "@/components/OverflowSafeSelect";
import styles from "@/components/my-pages.module.css";
import {
  APPROVAL_ASSIGNEE_SOURCE_LABELS,
  APPROVAL_NODE_TYPE_LABELS,
  NODE_TIMEOUT_MAX_HOURS,
  NODE_TIMEOUT_MIN_HOURS,
  validateTemplateNodes,
  type ApprovalAssigneeSource,
  type ApprovalFlowTemplateStatus,
  type ApprovalTemplateNode,
  type ApprovalTemplateNodeType,
} from "@/lib/approval-flow-template";

type TemplateRow = {
  id: string;
  name: string;
  description: string;
  resourceScope: string;
  status: ApprovalFlowTemplateStatus;
  nodes: ApprovalTemplateNode[];
  updatedAt: string;
};

type MemberOption = { userId: string; name: string };
type RoleOption = { name: string };

/** 新建模版的起点（客户端起手式，不是词表——存进服务端后与默认无任何绑定）。 */
function starterNodes(): ApprovalTemplateNode[] {
  return [
    {
      id: crypto.randomUUID(), type: "approval", title: "直属上级审批",
      assigneeSource: "supervisor", decisionMode: "any", timeoutHours: 24, optional: true,
    },
    {
      id: crypto.randomUUID(), type: "processing", title: "资源开通确认",
      assigneeSource: "holder", timeoutHours: 8, optional: false,
    },
  ];
}

const NEW_ID_PREFIX = "local-new-";

/** 切类型时的字段重整——服务端会拒绝残留字段（如 cc 带 decisionMode），别把脏值送出去。 */
function reconcileNodeType(node: ApprovalTemplateNode, type: ApprovalTemplateNodeType): ApprovalTemplateNode {
  const next: ApprovalTemplateNode = { ...node, type };
  if (type === "approval") next.decisionMode = "any";
  else delete next.decisionMode;
  if (type === "cc") next.timeoutHours = null;
  else if (next.timeoutHours === null && type === "processing") next.timeoutHours = 8;
  return next;
}

function nodeAssigneeSummary(
  node: ApprovalTemplateNode,
  members: MemberOption[],
): { label: string; people: string[] } {
  const label = APPROVAL_ASSIGNEE_SOURCE_LABELS[node.assigneeSource];
  if (node.assigneeSource === "project_role") {
    return { label, people: node.roleNames ?? [] };
  }
  if (node.assigneeSource === "specific_members") {
    const byId = new Map(members.map((m) => [m.userId, m.name]));
    return { label, people: (node.memberIds ?? []).map((id) => byId.get(id) ?? "未知成员") };
  }
  // 阶梯来源：人由引擎在进入节点时按当时组织关系解析（晚绑定），这里不做假预测
  return { label, people: [] };
}

export default function ApprovalFlowDesigner({ productionId }: { productionId: string }) {
  const api = `/api/production/${productionId}/approval-flow-templates`;

  const [templates, setTemplates] = useState<TemplateRow[]>([]);
  const [members, setMembers] = useState<MemberOption[]>([]);
  const [roles, setRoles] = useState<RoleOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [draggedNodeId, setDraggedNodeId] = useState<string | null>(null);
  const [dirtyIds, setDirtyIds] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setLoadError("");
    try {
      const [tRes, mRes, rRes] = await Promise.all([
        fetch(api),
        fetch(`/api/production/${productionId}/mention-users`),
        fetch(`/api/production/${productionId}/roles`),
      ]);
      if (!tRes.ok) throw new Error(`模版列表加载失败（${tRes.status}）`);
      const tData = (await tRes.json()) as { templates: TemplateRow[] };
      setTemplates(tData.templates);
      setSelectedTemplateId((cur) => cur ?? tData.templates[0]?.id ?? null);
      if (mRes.ok) {
        const mData = (await mRes.json()) as { users: MemberOption[] };
        setMembers(mData.users);
      }
      if (rRes.ok) {
        const rData = (await rRes.json()) as { roles: RoleOption[] };
        setRoles(rData.roles);
      }
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }, [api, productionId]);

  useEffect(() => { void reload(); }, [reload]);

  const selectedTemplate = useMemo(
    () => templates.find((t) => t.id === selectedTemplateId) ?? null,
    [selectedTemplateId, templates],
  );
  const selectedNode = selectedTemplate?.nodes.find((n) => n.id === selectedNodeId) ?? null;
  const isDirty = selectedTemplate ? dirtyIds.has(selectedTemplate.id) : false;
  const isNew = selectedTemplate?.id.startsWith(NEW_ID_PREFIX) ?? false;

  function flash(kind: "ok" | "error", text: string) {
    setNotice({ kind, text });
    if (kind === "ok") window.setTimeout(() => setNotice((n) => (n?.text === text ? null : n)), 2600);
  }

  function updateTemplate(patch: Partial<TemplateRow>) {
    if (!selectedTemplate) return;
    setTemplates((cur) => cur.map((t) => (t.id === selectedTemplate.id ? { ...t, ...patch } : t)));
    setDirtyIds((cur) => new Set(cur).add(selectedTemplate.id));
  }

  function updateNode(patch: Partial<ApprovalTemplateNode>) {
    if (!selectedTemplate || !selectedNode) return;
    updateTemplate({
      nodes: selectedTemplate.nodes.map((n) => (n.id === selectedNode.id ? { ...n, ...patch } : n)),
    });
  }

  function replaceNode(next: ApprovalTemplateNode) {
    if (!selectedTemplate) return;
    updateTemplate({ nodes: selectedTemplate.nodes.map((n) => (n.id === next.id ? next : n)) });
  }

  function addNode(type: ApprovalTemplateNodeType) {
    if (!selectedTemplate) return;
    const base: ApprovalTemplateNode = reconcileNodeType({
      id: crypto.randomUUID(),
      type,
      title: `新增${APPROVAL_NODE_TYPE_LABELS[type]}节点`,
      assigneeSource: type === "processing" ? "holder" : "supervisor",
      timeoutHours: 24,
      optional: type === "cc",
    }, type);
    const at = selectedNode
      ? selectedTemplate.nodes.findIndex((n) => n.id === selectedNode.id) + 1
      : selectedTemplate.nodes.length;
    const nodes = [...selectedTemplate.nodes];
    nodes.splice(at, 0, base);
    updateTemplate({ nodes });
    setSelectedNodeId(base.id);
  }

  function removeNode() {
    if (!selectedTemplate || !selectedNode || selectedTemplate.nodes.length === 1) return;
    const idx = selectedTemplate.nodes.findIndex((n) => n.id === selectedNode.id);
    const nodes = selectedTemplate.nodes.filter((n) => n.id !== selectedNode.id);
    updateTemplate({ nodes });
    setSelectedNodeId(nodes[Math.min(idx, nodes.length - 1)]?.id ?? null);
  }

  function reorderNode(fromIndex: number, toIndex: number) {
    if (!selectedTemplate) return;
    if (fromIndex < 0 || toIndex < 0 || toIndex >= selectedTemplate.nodes.length) return;
    const nodes = [...selectedTemplate.nodes];
    const [moved] = nodes.splice(fromIndex, 1);
    nodes.splice(toIndex, 0, moved);
    updateTemplate({ nodes });
    setSelectedNodeId(moved.id);
  }

  function dropNodeAt(targetIndex: number) {
    if (!selectedTemplate || !draggedNodeId) return;
    const fromIndex = selectedTemplate.nodes.findIndex((n) => n.id === draggedNodeId);
    if (fromIndex < 0 || fromIndex === targetIndex) return;
    // 先移除后插入：向下拖时目标位已左移一格，不修正会固定落到目标之后（#405 review）
    reorderNode(fromIndex, fromIndex < targetIndex ? targetIndex - 1 : targetIndex);
  }

  function createTemplate() {
    const id = `${NEW_ID_PREFIX}${crypto.randomUUID()}`;
    const next: TemplateRow = {
      id,
      name: `自定义流程 ${templates.length + 1}`,
      description: "",
      resourceScope: "",
      status: "draft",
      nodes: starterNodes(),
      updatedAt: new Date().toISOString(),
    };
    setTemplates((cur) => [...cur, next]);
    setDirtyIds((cur) => new Set(cur).add(id));
    setSelectedTemplateId(id);
    setSelectedNodeId(next.nodes[0].id);
  }

  async function saveSelected(): Promise<TemplateRow | null> {
    if (!selectedTemplate) return null;
    const clientErrors = validateTemplateNodes(selectedTemplate.nodes);
    if (clientErrors.length > 0) {
      flash("error", clientErrors[0]);
      return null;
    }
    setBusy(true);
    try {
      const payload = {
        name: selectedTemplate.name,
        description: selectedTemplate.description,
        resourceScope: selectedTemplate.resourceScope,
        nodes: selectedTemplate.nodes,
      };
      const res = isNew
        ? await fetch(api, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) })
        : await fetch(`${api}/${selectedTemplate.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const data = (await res.json()) as { template?: TemplateRow; error?: string; errors?: string[] };
      if (!res.ok || !data.template) {
        flash("error", data.errors?.[0] ?? data.error ?? "保存失败");
        return null;
      }
      const saved = data.template;
      const oldId = selectedTemplate.id;
      setTemplates((cur) => cur.map((t) => (t.id === oldId ? saved : t)));
      setDirtyIds((cur) => { const n = new Set(cur); n.delete(oldId); return n; });
      setSelectedTemplateId(saved.id);
      flash("ok", "已保存");
      return saved;
    } finally {
      setBusy(false);
    }
  }

  async function publishSelected() {
    if (!selectedTemplate) return;
    // 发布是真动作（引擎已生效）：先落库再发布，并说清影响面
    const confirmed = window.confirm(
      "发布后，本项目新提交的资源申请将按此流程流转（在途申请不受影响；已发布的其他模版会转回草稿）。确认发布？",
    );
    if (!confirmed) return;
    const saved = isDirty || isNew ? await saveSelected() : selectedTemplate;
    if (!saved) return;
    setBusy(true);
    try {
      const res = await fetch(`${api}/${saved.id}/publish`, { method: "POST" });
      const data = (await res.json()) as { template?: TemplateRow; error?: string };
      if (!res.ok || !data.template) {
        flash("error", data.error ?? "发布失败");
        return;
      }
      await reload();
      setSelectedTemplateId(data.template.id);
      flash("ok", "已发布，此流程即刻对新申请生效");
    } finally {
      setBusy(false);
    }
  }

  async function unpublishSelected() {
    if (!selectedTemplate || isNew) return;
    setBusy(true);
    try {
      const res = await fetch(`${api}/${selectedTemplate.id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "draft" }),
      });
      const data = (await res.json()) as { template?: TemplateRow; error?: string };
      if (!res.ok || !data.template) {
        flash("error", data.error ?? "操作失败");
        return;
      }
      setTemplates((cur) => cur.map((t) => (t.id === data.template!.id ? data.template! : t)));
      flash("ok", "已转回草稿，新申请回到默认阶梯流程");
    } finally {
      setBusy(false);
    }
  }

  async function deleteSelected() {
    if (!selectedTemplate) return;
    if (isNew) {
      setTemplates((cur) => cur.filter((t) => t.id !== selectedTemplate.id));
      setSelectedTemplateId(null);
      return;
    }
    if (!window.confirm(`删除模版「${selectedTemplate.name}」？此操作不可恢复。`)) return;
    setBusy(true);
    try {
      const res = await fetch(`${api}/${selectedTemplate.id}`, { method: "DELETE" });
      if (!res.ok) {
        const data = (await res.json()) as { error?: string };
        flash("error", data.error ?? "删除失败");
        return;
      }
      setTemplates((cur) => cur.filter((t) => t.id !== selectedTemplate.id));
      setSelectedTemplateId(null);
      flash("ok", "已删除");
    } finally {
      setBusy(false);
    }
  }

  function toggleListValue(list: string[] | undefined, value: string): string[] {
    const cur = list ?? [];
    return cur.includes(value) ? cur.filter((v) => v !== value) : [...cur, value];
  }

  if (loading) return <p className={styles.approvalDesignerHint}>加载流程模版…</p>;
  if (loadError) {
    return (
      <div className={styles.approvalDesignerHint}>
        <p>{loadError}</p>
        <button type="button" className={styles.approvalSecondaryButton} onClick={() => void reload()}>重试</button>
      </div>
    );
  }

  return (
    <div className={styles.approvalDesigner}>
      <header className={styles.approvalDesignerHeader}>
        <div>
          <p className={styles.approvalDesignerKicker}>APPROVAL BLUEPRINT</p>
          <h2>审批流程模版</h2>
          <p>发布中的模版决定新资源申请的流转路径；未发布时走默认阶梯。点击节点展开设置，拖动或用箭头排序。</p>
        </div>
        <div className={styles.approvalDesignerActions}>
          {notice && (
            <span className={notice.kind === "ok" ? styles.approvalDraftSaved : styles.approvalDesignerError}>
              {notice.text}
            </span>
          )}
          <button type="button" className={styles.approvalSecondaryButton} onClick={createTemplate} disabled={busy}>
            新建模版
          </button>
          {selectedTemplate && (
            <>
              <button
                type="button"
                className={styles.approvalPrimaryButton}
                onClick={() => void saveSelected()}
                disabled={busy || (!isDirty && !isNew)}
              >
                {isNew ? "保存新模版" : isDirty ? "保存修改" : "已保存"}
              </button>
              {selectedTemplate.status === "published" ? (
                <button type="button" className={styles.approvalSecondaryButton} onClick={() => void unpublishSelected()} disabled={busy}>
                  转回草稿
                </button>
              ) : (
                <button type="button" className={styles.approvalPublishButton} onClick={() => void publishSelected()} disabled={busy}>
                  发布到项目
                </button>
              )}
            </>
          )}
        </div>
      </header>

      <div className={styles.approvalDesignerGrid}>
        <aside className={styles.approvalTemplateShelf}>
          <div className={styles.approvalShelfHeading}>
            <span>流程模版</span>
            <small>{templates.length}</small>
          </div>
          <div className={styles.approvalTemplateList}>
            {templates.map((template) => (
              <button
                type="button"
                key={template.id}
                className={`${styles.approvalTemplateCard} ${template.id === selectedTemplateId ? styles.approvalTemplateCardActive : ""}`}
                onClick={() => {
                  setSelectedTemplateId(template.id);
                  setSelectedNodeId(template.nodes[0]?.id ?? null);
                }}
              >
                <span>{template.status === "published" ? "使用中" : dirtyIds.has(template.id) ? "未保存" : "草稿"}</span>
                <b>{template.name}</b>
                <small>{template.resourceScope || "全部资源申请"}</small>
                <i>{template.nodes.length} 个节点</i>
              </button>
            ))}
            {templates.length === 0 && (
              <p className={styles.approvalDesignerHint}>
                还没有模版。新建并发布后，新资源申请将按模版流转；在此之前走默认阶梯（直属上级 → 资源治理链 → Owner）。
              </p>
            )}
          </div>
        </aside>

        <section className={styles.approvalFlowCanvas}>
          {!selectedTemplate ? (
            <p className={styles.approvalDesignerHint}>选择左侧模版，或「新建模版」开始设计。</p>
          ) : (
            <>
              <div className={styles.approvalFlowCanvasTopline}>
                <div>
                  <label htmlFor="approval-template-name">模版名称</label>
                  <input
                    id="approval-template-name"
                    value={selectedTemplate.name}
                    onChange={(e) => updateTemplate({ name: e.target.value })}
                  />
                </div>
                <span>{selectedTemplate.status === "published" ? "使用中" : "草稿"}</span>
              </div>

              <div className={styles.approvalFlowRail}>
                <div className={styles.approvalFlowStageRow}>
                  <div className={styles.approvalFlowTrack}>
                    <span>0</span>
                    <i />
                  </div>
                  <div className={`${styles.approvalFlowNode} ${styles.approvalFlowNodeFixed}`}>
                    <div>
                      <small>发起</small>
                      <b>提交资源申请</b>
                    </div>
                    <p>申请人</p>
                    <em>固定节点</em>
                  </div>
                </div>

                {selectedTemplate.nodes.map((node, index) => {
                  const expanded = node.id === selectedNodeId;
                  const summary = nodeAssigneeSummary(node, members);
                  return (
                    <div
                      key={node.id}
                      className={styles.approvalFlowNodeWrap}
                      onDragOver={(e) => e.preventDefault()}
                      onDrop={() => {
                        dropNodeAt(index);
                        setDraggedNodeId(null);
                      }}
                    >
                      <div className={styles.approvalFlowTrack}>
                        <span>{index + 1}</span>
                        <i />
                      </div>
                      <div className={styles.approvalFlowStageBody}>
                        <div
                          className={`${styles.approvalFlowNode} ${styles[`approvalFlowNode${node.type[0].toUpperCase()}${node.type.slice(1)}`]} ${expanded ? `${styles.approvalFlowNodeSelected} ${styles.approvalFlowNodeExpanded}` : ""} ${draggedNodeId === node.id ? styles.approvalFlowNodeDragging : ""}`}
                          draggable
                          onDragStart={(e) => {
                            setDraggedNodeId(node.id);
                            e.dataTransfer.effectAllowed = "move";
                          }}
                          onDragEnd={() => setDraggedNodeId(null)}
                        >
                          <button
                            type="button"
                            className={styles.approvalFlowNodeSelect}
                            aria-expanded={expanded}
                            onClick={() => setSelectedNodeId(expanded ? null : node.id)}
                          >
                            <div className={styles.approvalNodePrimary}>
                              <small>
                                {APPROVAL_NODE_TYPE_LABELS[node.type]}
                                {node.type === "approval" ? " · 任一人通过" : node.type === "cc" ? " · 到达即知会" : " · 审批后开通"}
                              </small>
                              <b>{node.title}</b>
                            </div>
                            <div className={styles.approvalNodeAssignee}>
                              <small>处理人</small>
                              <p>{summary.label}</p>
                            </div>
                            <div className={styles.approvalNodePeople}>
                              {summary.people.length > 0
                                ? summary.people.map((p) => <span key={p}><i>{p}</i></span>)
                                : <span><i>按届时组织关系解析</i></span>}
                            </div>
                            <em>{node.optional ? "可跳过" : node.timeoutHours ? `${node.timeoutHours}h` : node.type === "cc" ? "自动" : "不超时"}</em>
                          </button>
                          <div className={styles.approvalNodeOrderControls}>
                            <span title="按住并拖动排序" aria-hidden="true">⠿</span>
                            <button
                              type="button"
                              aria-label={`上移 ${node.title}`}
                              disabled={index === 0}
                              onClick={() => reorderNode(index, index - 1)}
                            >▲</button>
                            <button
                              type="button"
                              aria-label={`下移 ${node.title}`}
                              disabled={index === selectedTemplate.nodes.length - 1}
                              onClick={() => reorderNode(index, index + 1)}
                            >▼</button>
                          </div>
                        </div>

                        {expanded && (
                          <div className={styles.approvalInlineEditor}>
                            <div className={styles.approvalInlineEditorGrid}>
                              <label>
                                节点名称
                                <input value={node.title} onChange={(e) => updateNode({ title: e.target.value })} />
                              </label>
                              <label>
                                节点类型
                                <OverflowSafeSelect
                                  value={node.type}
                                  onChange={(e) => replaceNode(reconcileNodeType(node, e.target.value as ApprovalTemplateNodeType))}
                                >
                                  {Object.entries(APPROVAL_NODE_TYPE_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                                </OverflowSafeSelect>
                              </label>
                              <label>
                                处理人来源
                                <OverflowSafeSelect
                                  value={node.assigneeSource}
                                  onChange={(e) => {
                                    const source = e.target.value as ApprovalAssigneeSource;
                                    const next: ApprovalTemplateNode = { ...node, assigneeSource: source };
                                    if (source !== "project_role") delete next.roleNames;
                                    if (source !== "specific_members") delete next.memberIds;
                                    replaceNode(next);
                                  }}
                                >
                                  {Object.entries(APPROVAL_ASSIGNEE_SOURCE_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                                </OverflowSafeSelect>
                              </label>
                              {node.type !== "cc" && (
                                <label>
                                  超时处理（小时，留空 = 不超时）
                                  <input
                                    type="number"
                                    min={NODE_TIMEOUT_MIN_HOURS}
                                    max={NODE_TIMEOUT_MAX_HOURS}
                                    value={node.timeoutHours ?? ""}
                                    onChange={(e) => {
                                      const raw = e.target.value;
                                      if (raw === "") { updateNode({ timeoutHours: null }); return; }
                                      const n = Number(raw);
                                      if (Number.isInteger(n)) updateNode({ timeoutHours: Math.min(NODE_TIMEOUT_MAX_HOURS, Math.max(NODE_TIMEOUT_MIN_HOURS, n)) });
                                    }}
                                  />
                                </label>
                              )}
                              {node.type === "approval" && (
                                <label>
                                  多人策略
                                  <input value="任一人通过（或签）· 会签后续开放" disabled />
                                </label>
                              )}
                            </div>

                            {node.assigneeSource === "project_role" && (
                              <div className={styles.approvalPickerGroup}>
                                <small>选择角色（至少一个）</small>
                                <div className={styles.approvalPickerChips}>
                                  {roles.map((r) => (
                                    <label key={r.name} className={styles.approvalPickerChip}>
                                      <input
                                        type="checkbox"
                                        checked={(node.roleNames ?? []).includes(r.name)}
                                        onChange={() => updateNode({ roleNames: toggleListValue(node.roleNames, r.name) })}
                                      />
                                      {r.name}
                                    </label>
                                  ))}
                                  {roles.length === 0 && <span>本项目还没有角色</span>}
                                </div>
                              </div>
                            )}
                            {node.assigneeSource === "specific_members" && (
                              <div className={styles.approvalPickerGroup}>
                                <small>选择成员（至少一位）</small>
                                <div className={styles.approvalPickerChips}>
                                  {members.map((m) => (
                                    <label key={m.userId} className={styles.approvalPickerChip}>
                                      <input
                                        type="checkbox"
                                        checked={(node.memberIds ?? []).includes(m.userId)}
                                        onChange={() => updateNode({ memberIds: toggleListValue(node.memberIds, m.userId) })}
                                      />
                                      {m.name}
                                    </label>
                                  ))}
                                </div>
                              </div>
                            )}

                            <div className={styles.approvalInlineEditorFooter}>
                              <label className={styles.approvalOptionalToggle}>
                                <input
                                  type="checkbox"
                                  checked={node.optional}
                                  onChange={(e) => updateNode({ optional: e.target.checked })}
                                />
                                无匹配处理人或超时无人处理时跳过（不勾选则转交 Owner）
                              </label>
                              <div className={styles.approvalInlineEditorFooterActions}>
                                <button
                                  type="button"
                                  className={styles.approvalInlineEditorClose}
                                  aria-label={`收起 ${node.title}`}
                                  onClick={() => setSelectedNodeId(null)}
                                >收起</button>
                                <button
                                  type="button"
                                  className={styles.approvalDangerButton}
                                  onClick={removeNode}
                                  disabled={selectedTemplate.nodes.length === 1}
                                >删除节点</button>
                              </div>
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}

                <div className={styles.approvalFlowStageRow}>
                  <div className={`${styles.approvalFlowTrack} ${styles.approvalFlowTrackLast}`}>
                    <span>✓</span>
                  </div>
                  <div className={`${styles.approvalFlowNode} ${styles.approvalFlowNodeFixed}`}>
                    <div>
                      <small>结束</small>
                      <b>流程完成</b>
                    </div>
                    <p>全部节点完成后发放权限</p>
                    <em>固定节点</em>
                  </div>
                </div>
              </div>

              <div className={styles.approvalAddNodeBar}>
                <span>在选中节点后添加</span>
                {(["approval", "cc", "processing"] as ApprovalTemplateNodeType[]).map((type) => (
                  <button type="button" key={type} onClick={() => addNode(type)}>+ {APPROVAL_NODE_TYPE_LABELS[type]}</button>
                ))}
                {selectedTemplate.status !== "published" && (
                  <button type="button" className={styles.approvalDangerButton} onClick={() => void deleteSelected()} disabled={busy}>
                    删除模版
                  </button>
                )}
              </div>
              <div className={styles.approvalBackendNotice}>
                <b>发布即生效</b>
                <p>
                  发布中的模版对**新提交**的申请生效；在途申请按提交时定格的流程走完。
                  处理人在流程走到该节点时按当时的组织关系解析（预测非承诺）。
                </p>
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  );
}
