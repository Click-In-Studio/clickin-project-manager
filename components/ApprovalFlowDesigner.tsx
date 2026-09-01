"use client";

import { useEffect, useMemo, useState } from "react";
import OverflowSafeSelect from "@/components/OverflowSafeSelect";
import styles from "@/components/my-pages.module.css";
import {
  APPROVAL_ASSIGNEE_SOURCE_LABELS,
  APPROVAL_DECISION_MODE_LABELS,
  APPROVAL_NODE_TYPE_LABELS,
  DEFAULT_APPROVAL_FLOW_TEMPLATES,
  createApprovalTemplateNode,
  moveApprovalTemplateNode,
  type ApprovalAssigneeSource,
  type ApprovalDecisionMode,
  type ApprovalFlowTemplate,
  type ApprovalTemplateNode,
  type ApprovalTemplateNodeType,
} from "@/lib/approval-flow-template";

const STORAGE_KEY = "backstage:approval-flow-template-draft:v1";

function cloneDefaults(): ApprovalFlowTemplate[] {
  return DEFAULT_APPROVAL_FLOW_TEMPLATES.map((template) => ({
    ...template,
    nodes: template.nodes.map((node) => ({ ...node })),
  }));
}

function examplePeople(node: ApprovalTemplateNode): string[] {
  if (node.assigneeSource === "supervisor") return ["刘杰熙"];
  if (node.assigneeSource === "resource_owner") return ["周岑"];
  if (node.assigneeSource === "project_owner") return ["谢闻舟"];
  if (node.assigneeSource === "department_poc") return ["姜予安"];
  if (node.assigneeSource === "specific_members") return ["已指定成员"];
  if (node.type === "cc") return ["唐澄", "谢闻舟"];
  return node.decisionMode === "all" ? ["姜予安", "唐澄"] : ["姜予安"];
}

function nodeSummary(node: ApprovalTemplateNode): string {
  if (node.type === "cc") return "到达此节点时自动知会";
  if (node.type === "processing") return "审批通过后完成实际开通";
  return APPROVAL_DECISION_MODE_LABELS[node.decisionMode];
}

export default function ApprovalFlowDesigner() {
  const [templates, setTemplates] = useState<ApprovalFlowTemplate[]>(cloneDefaults);
  const [selectedTemplateId, setSelectedTemplateId] = useState(DEFAULT_APPROVAL_FLOW_TEMPLATES[0].id);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(DEFAULT_APPROVAL_FLOW_TEMPLATES[0].nodes[0].id);
  const [draggedNodeId, setDraggedNodeId] = useState<string | null>(null);
  const [savedMessage, setSavedMessage] = useState("");

  useEffect(() => {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    try {
      const saved = JSON.parse(raw) as ApprovalFlowTemplate[];
      if (Array.isArray(saved) && saved.length > 0 && saved.every((template) => Array.isArray(template.nodes))) {
        setTemplates(saved);
        setSelectedTemplateId(saved[0].id);
        setSelectedNodeId(saved[0].nodes[0]?.id ?? null);
      }
    } catch {
      window.localStorage.removeItem(STORAGE_KEY);
    }
  }, []);

  const selectedTemplate = useMemo(
    () => templates.find((template) => template.id === selectedTemplateId) ?? templates[0],
    [selectedTemplateId, templates],
  );
  const selectedNode = selectedTemplate?.nodes.find((node) => node.id === selectedNodeId) ?? null;

  function updateTemplate(patch: Partial<ApprovalFlowTemplate>) {
    setTemplates((current) => current.map((template) => (
      template.id === selectedTemplate.id ? { ...template, ...patch } : template
    )));
  }

  function updateNode(patch: Partial<ApprovalTemplateNode>) {
    if (!selectedNode) return;
    updateTemplate({
      nodes: selectedTemplate.nodes.map((node) => node.id === selectedNode.id ? { ...node, ...patch } : node),
    });
  }

  function addNode(type: ApprovalTemplateNodeType) {
    const ordinal = selectedTemplate.nodes.length + 1;
    const nextNode = createApprovalTemplateNode(type, ordinal);
    const selectedIndex = selectedNode
      ? selectedTemplate.nodes.findIndex((node) => node.id === selectedNode.id)
      : selectedTemplate.nodes.length - 1;
    const nextNodes = [...selectedTemplate.nodes];
    nextNodes.splice(selectedIndex + 1, 0, nextNode);
    updateTemplate({ nodes: nextNodes });
    setSelectedNodeId(nextNode.id);
  }

  function removeNode() {
    if (!selectedNode || selectedTemplate.nodes.length === 1) return;
    const index = selectedTemplate.nodes.findIndex((node) => node.id === selectedNode.id);
    const nextNodes = selectedTemplate.nodes.filter((node) => node.id !== selectedNode.id);
    updateTemplate({ nodes: nextNodes });
    setSelectedNodeId(nextNodes[Math.min(index, nextNodes.length - 1)]?.id ?? null);
  }

  function moveNode(nodeId: string, direction: -1 | 1) {
    const index = selectedTemplate.nodes.findIndex((node) => node.id === nodeId);
    updateTemplate({ nodes: moveApprovalTemplateNode(selectedTemplate.nodes, index, direction) });
  }

  function dropNodeAt(targetIndex: number) {
    if (!draggedNodeId) return;
    const fromIndex = selectedTemplate.nodes.findIndex((node) => node.id === draggedNodeId);
    if (fromIndex < 0 || fromIndex === targetIndex) return;
    const nextNodes = [...selectedTemplate.nodes];
    const [moved] = nextNodes.splice(fromIndex, 1);
    nextNodes.splice(targetIndex, 0, moved);
    updateTemplate({ nodes: nextNodes });
    setSelectedNodeId(moved.id);
  }

  function createTemplate() {
    const ordinal = templates.length + 1;
    const source = DEFAULT_APPROVAL_FLOW_TEMPLATES[0];
    const id = `custom-${Date.now()}`;
    const next: ApprovalFlowTemplate = {
      ...source,
      id,
      name: `自定义流程 ${ordinal}`,
      description: "从标准资源权限模板复制，可继续增减和调整节点。",
      enabled: false,
      nodes: source.nodes.map((node, index) => ({ ...node, id: `${id}-${index + 1}` })),
    };
    setTemplates((current) => [...current, next]);
    setSelectedTemplateId(id);
    setSelectedNodeId(next.nodes[0].id);
  }

  function saveDraft() {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(templates));
    setSavedMessage("已保存到本机设计草稿");
    window.setTimeout(() => setSavedMessage(""), 2400);
  }

  if (!selectedTemplate) return null;

  return (
    <div className={styles.approvalDesigner}>
      <header className={styles.approvalDesignerHeader}>
        <div>
          <p className={styles.approvalDesignerKicker}>APPROVAL BLUEPRINT</p>
          <h2>审批流程模板</h2>
          <p>点击节点展开设置；按住卡片拖动，或使用右侧箭头调整顺序。</p>
        </div>
        <div className={styles.approvalDesignerActions}>
          {savedMessage && <span className={styles.approvalDraftSaved}>{savedMessage}</span>}
          <button type="button" className={styles.approvalSecondaryButton} onClick={createTemplate}>复制为新模板</button>
          <button type="button" className={styles.approvalPrimaryButton} onClick={saveDraft}>保存草稿</button>
          <button
            type="button"
            className={styles.approvalPublishButton}
            disabled
            title="待后端提供模板版本与发布接口后启用"
          >
            发布到项目
          </button>
        </div>
      </header>

      <div className={styles.approvalDesignerGrid}>
        <aside className={styles.approvalTemplateShelf}>
          <div className={styles.approvalShelfHeading}>
            <span>流程模板</span>
            <small>{templates.length}</small>
          </div>
          <div className={styles.approvalTemplateList}>
            {templates.map((template) => (
              <button
                type="button"
                key={template.id}
                className={`${styles.approvalTemplateCard} ${template.id === selectedTemplate.id ? styles.approvalTemplateCardActive : ""}`}
                onClick={() => {
                  setSelectedTemplateId(template.id);
                  setSelectedNodeId(template.nodes[0]?.id ?? null);
                }}
              >
                <span>{template.enabled ? "使用中" : "草稿"}</span>
                <b>{template.name}</b>
                <small>{template.resourceScope}</small>
                <i>{template.nodes.length} 个节点</i>
              </button>
            ))}
          </div>
        </aside>

        <section className={styles.approvalFlowCanvas}>
          <div className={styles.approvalFlowCanvasTopline}>
            <div>
              <label htmlFor="approval-template-name">模板名称</label>
              <input
                id="approval-template-name"
                value={selectedTemplate.name}
                onChange={(event) => updateTemplate({ name: event.target.value })}
              />
            </div>
            <span>{selectedTemplate.enabled ? "当前启用" : "未发布草稿"}</span>
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
                <p>申请人 · 陈雨</p>
                <em>固定节点</em>
              </div>
            </div>

            {selectedTemplate.nodes.map((node, index) => {
              const people = examplePeople(node);
              const expanded = node.id === selectedNodeId;
              return (
                <div
                  key={node.id}
                  className={styles.approvalFlowNodeWrap}
                  onDragOver={(event) => event.preventDefault()}
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
                      onDragStart={(event) => {
                        setDraggedNodeId(node.id);
                        event.dataTransfer.effectAllowed = "move";
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
                          <small>{APPROVAL_NODE_TYPE_LABELS[node.type]} · {nodeSummary(node)}</small>
                          <b>{node.title}</b>
                        </div>
                        <div className={styles.approvalNodeAssignee}>
                          <small>处理人</small>
                          <p>{node.assigneeLabel}</p>
                        </div>
                        <div className={styles.approvalNodePeople}>
                          {people.map((person) => <span key={person}>{person.slice(-2)} <i>{person}</i></span>)}
                        </div>
                        <em>{node.optional ? "可跳过" : node.timeoutHours ? `${node.timeoutHours}h` : "自动"}</em>
                      </button>
                      <div className={styles.approvalNodeOrderControls}>
                        <span title="按住并拖动排序" aria-hidden="true">⠿</span>
                        <button
                          type="button"
                          aria-label={`上移 ${node.title}`}
                          disabled={index === 0}
                          onClick={() => {
                            setSelectedNodeId(node.id);
                            moveNode(node.id, -1);
                          }}
                        >▲</button>
                        <button
                          type="button"
                          aria-label={`下移 ${node.title}`}
                          disabled={index === selectedTemplate.nodes.length - 1}
                          onClick={() => {
                            setSelectedNodeId(node.id);
                            moveNode(node.id, 1);
                          }}
                        >▼</button>
                      </div>
                    </div>

                    {expanded && (
                      <div className={styles.approvalInlineEditor}>
                        <div className={styles.approvalInlineEditorGrid}>
                          <label>
                            节点名称
                            <input value={node.title} onChange={(event) => updateNode({ title: event.target.value })} />
                          </label>
                          <label>
                            节点类型
                            <OverflowSafeSelect
                              value={node.type}
                              onChange={(event) => updateNode({ type: event.target.value as ApprovalTemplateNodeType })}
                            >
                              {Object.entries(APPROVAL_NODE_TYPE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                            </OverflowSafeSelect>
                          </label>
                          <label>
                            处理人来源
                            <OverflowSafeSelect
                              value={node.assigneeSource}
                              onChange={(event) => {
                                const source = event.target.value as ApprovalAssigneeSource;
                                updateNode({ assigneeSource: source, assigneeLabel: APPROVAL_ASSIGNEE_SOURCE_LABELS[source] });
                              }}
                            >
                              {Object.entries(APPROVAL_ASSIGNEE_SOURCE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                            </OverflowSafeSelect>
                          </label>
                          <label>
                            显示名称 / 角色
                            <input value={node.assigneeLabel} onChange={(event) => updateNode({ assigneeLabel: event.target.value })} />
                          </label>
                          {node.type === "approval" && (
                            <label>
                              多人策略
                              <OverflowSafeSelect
                                value={node.decisionMode}
                                onChange={(event) => updateNode({ decisionMode: event.target.value as ApprovalDecisionMode })}
                              >
                                {Object.entries(APPROVAL_DECISION_MODE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                              </OverflowSafeSelect>
                            </label>
                          )}
                          {node.type !== "cc" && (
                            <label>
                              超时处理（小时）
                              <input
                                type="number"
                                min={1}
                                max={720}
                                value={node.timeoutHours ?? 24}
                                onChange={(event) => updateNode({ timeoutHours: Math.max(1, Number(event.target.value) || 1) })}
                              />
                            </label>
                          )}
                        </div>
                        <div className={styles.approvalInlineEditorFooter}>
                          <label className={styles.approvalOptionalToggle}>
                            <input
                              type="checkbox"
                              checked={node.optional}
                              onChange={(event) => updateNode({ optional: event.target.checked })}
                            />
                            无匹配处理人时允许跳过
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
                <p>审批决定与实际处理均已完成</p>
                <em>固定节点</em>
              </div>
            </div>
          </div>

          <div className={styles.approvalAddNodeBar}>
            <span>在选中节点后添加</span>
            {(["approval", "cc", "processing"] as ApprovalTemplateNodeType[]).map((type) => (
              <button type="button" key={type} onClick={() => addNode(type)}>+ {APPROVAL_NODE_TYPE_LABELS[type]}</button>
            ))}
          </div>
          <div className={styles.approvalBackendNotice}>
            <b>当前为可交互设计草稿</b>
            <p>增删、排序和配置会保存在本机。发布、版本、条件分支与运行中实例快照需要后端接口后才能启用。</p>
          </div>
        </section>
      </div>
    </div>
  );
}
