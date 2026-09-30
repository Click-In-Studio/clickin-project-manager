"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { BASE_PATH } from "@/lib/base-path";
import { PRIMARY_BTN } from "@/components/ui/PageHeader";
import OverflowSafeSelect from "@/components/ui/OverflowSafeSelect";
import AssetUploadPanel from "@/components/assets/AssetUploadPanel";
import { useAssetUploadManager } from "@/components/assets/asset-upload-manager";
import styles from "./finance-expense-actions.module.css";

export type ExpenseCategoryOption = {
  id: string;
  name: string;
  deptName: string | null;
};

type ExpenseAction = "approve" | "reject";
type DocumentKind = "invoice" | "receipt" | "other";

export type ExpenseDocumentView = {
  id: string;
  assetId: string;
  assetFileId: string;
  kind: DocumentKind;
  fileName: string;
  mimeType: string | null;
};

type StagedDocument = ExpenseDocumentView;
type PendingDocument = { taskId: string; fileName: string; kind: DocumentKind };

const DOCUMENT_KIND_LABEL: Record<DocumentKind, string> = {
  invoice: "发票",
  receipt: "收据",
  other: "其他依据",
};

async function responseError(response: Response, fallback: string) {
  const data = await response.json().catch(() => ({})) as { error?: string };
  return data.error ?? fallback;
}

export function ExpenseCreateButton({ productionId, categories }: {
  productionId: string;
  categories: ExpenseCategoryOption[];
}) {
  const router = useRouter();
  const uploadManager = useAssetUploadManager();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [amount, setAmount] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [note, setNote] = useState("");
  const [invoiceRequirement, setInvoiceRequirement] = useState<"required" | "waived">("required");
  const [invoiceWaiverReason, setInvoiceWaiverReason] = useState("");
  const [documents, setDocuments] = useState<StagedDocument[]>([]);
  const [pendingDocuments, setPendingDocuments] = useState<PendingDocument[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const resetForm = useCallback(() => {
    setOpen(false);
    setTitle("");
    setAmount("");
    setCategoryId("");
    setNote("");
    setInvoiceRequirement("required");
    setInvoiceWaiverReason("");
    setDocuments([]);
    setPendingDocuments([]);
    setError(null);
  }, []);

  const discardDocument = useCallback(async (assetId: string) => {
    await fetch(`${BASE_PATH}/api/production/${productionId}/finance/expense-documents/${assetId}`, {
      method: "DELETE",
    }).catch(() => {});
  }, [productionId]);

  const close = useCallback(() => {
    if (saving) return;
    for (const pending of pendingDocuments) {
      const task = uploadManager?.tasks.find(item => item.id === pending.taskId);
      if (task?.result) void discardDocument(task.result.assetId);
      uploadManager?.dismissTask(pending.taskId);
    }
    for (const document of documents) void discardDocument(document.assetId);
    resetForm();
  }, [discardDocument, documents, pendingDocuments, resetForm, saving, uploadManager]);

  const pendingTasks = pendingDocuments.map(pending => ({
    pending,
    task: uploadManager?.tasks.find(task => task.id === pending.taskId),
  }));
  const uploading = pendingDocuments.length > 0;

  useEffect(() => {
    const completed = pendingTasks.filter(item => item.task?.status === "complete" && item.task.result);
    if (completed.length === 0) return;
    setDocuments(current => [
      ...current,
      ...completed.map(({ pending, task }) => ({
        id: task!.result!.fileId,
        assetId: task!.result!.assetId,
        assetFileId: task!.result!.fileId,
        kind: pending.kind,
        fileName: task!.result!.fileName,
        mimeType: null,
      })),
    ]);
    const completedIds = new Set(completed.map(item => item.pending.taskId));
    setPendingDocuments(current => current.filter(item => !completedIds.has(item.taskId)));
    for (const id of completedIds) uploadManager?.dismissTask(id);
  }, [pendingTasks, uploadManager]);

  useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !saving) close();
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [close, open, saving]);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving || uploading) return;
    setSaving(true);
    setError(null);
    try {
      const response = await fetch(`${BASE_PATH}/api/production/${productionId}/finance/expenses`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: title.trim(),
          amount: amount.trim(),
          categoryId: categoryId || null,
          note: note.trim(),
          invoiceRequirement,
          invoiceWaiverReason: invoiceRequirement === "waived" ? invoiceWaiverReason.trim() : "",
          documents: documents.map(document => ({
            assetFileId: document.assetFileId,
            kind: document.kind,
          })),
        }),
      });
      if (!response.ok) throw new Error(await responseError(response, "报销单提交失败"));
      resetForm();
      router.refresh();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "报销单提交失败");
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <button type="button" style={PRIMARY_BTN} onClick={() => setOpen(true)}>
        ＋ 新建报销
      </button>
      {open && (
        <div
          className={`app-mobile-input-overlay ${styles.backdrop}`}
          role="presentation"
          onMouseDown={event => { if (event.target === event.currentTarget) close(); }}
        >
          <aside className={`app-mobile-input-overlay app-mobile-input-surface ${styles.drawer}`} role="dialog" aria-modal="true" aria-labelledby="expense-create-title">
            <form onSubmit={submit} className={styles.form}>
              <header className={styles.header}>
                <div>
                  <p>REIMBURSEMENT</p>
                  <h2 id="expense-create-title">新建报销</h2>
                </div>
                <button type="button" className={styles.closeButton} disabled={saving} onClick={close} aria-label="关闭报销单">×</button>
              </header>

              <p className={styles.lead}>填写实际垫付的费用。提交后会按项目安排审批；只有你自己可以审批时会直接通过。</p>

              <div className={styles.fields}>
                <label className={styles.field}>
                  <span>事由</span>
                  <input
                    autoFocus
                    required
                    value={title}
                    onChange={event => setTitle(event.target.value)}
                    placeholder="例如：合成排练交通费"
                  />
                </label>

                <label className={styles.field}>
                  <span>发票要求</span>
                  <OverflowSafeSelect
                    value={invoiceRequirement}
                    onChange={event => setInvoiceRequirement(event.target.value as "required" | "waived")}
                  >
                    <option value="required">需要发票（可稍后补）</option>
                    <option value="waived">无需或无法提供发票</option>
                  </OverflowSafeSelect>
                </label>

                {invoiceRequirement === "waived" && (
                  <label className={styles.field}>
                    <span>无发票原因</span>
                    <textarea
                      required
                      rows={2}
                      value={invoiceWaiverReason}
                      onChange={event => setInvoiceWaiverReason(event.target.value)}
                      placeholder="例如：个人卖家无法开具发票"
                    />
                  </label>
                )}

                <section className={styles.documentsSection}>
                  <div className={styles.documentsHeading}>
                    <span>发票与收据</span>
                    <small>{documents.length > 0
                      ? `已添加 ${documents.length} 份`
                      : invoiceRequirement === "required" ? "可稍后补，提交后显示待补票" : "可上传收据或其他依据"}</small>
                  </div>
                  {documents.map(document => (
                    <div key={document.assetFileId} className={styles.documentRow}>
                      <span title={document.fileName}>{document.fileName}</span>
                      <OverflowSafeSelect
                        aria-label={`${document.fileName}的凭证类型`}
                        value={document.kind}
                        onChange={event => setDocuments(current => current.map(item =>
                          item.assetFileId === document.assetFileId
                            ? { ...item, kind: event.target.value as DocumentKind }
                            : item))}
                      >
                        {Object.entries(DOCUMENT_KIND_LABEL).map(([value, label]) => (
                          <option key={value} value={value}>{label}</option>
                        ))}
                      </OverflowSafeSelect>
                      <button type="button" onClick={() => void openExpenseDocument(productionId, document.assetId, false)}>预览</button>
                      <button type="button" onClick={() => {
                        setDocuments(current => current.filter(item => item.assetFileId !== document.assetFileId));
                        void discardDocument(document.assetId);
                      }}>移除</button>
                    </div>
                  ))}
                  {pendingTasks.map(({ pending, task }) => (
                    <div key={pending.taskId} className={styles.documentRow}>
                      <span title={pending.fileName}>{pending.fileName}</span>
                      <OverflowSafeSelect
                        aria-label={`${pending.fileName}的凭证类型`}
                        value={pending.kind}
                        onChange={event => setPendingDocuments(current => current.map(item =>
                          item.taskId === pending.taskId ? { ...item, kind: event.target.value as DocumentKind } : item))}
                      >
                        {Object.entries(DOCUMENT_KIND_LABEL).map(([value, label]) => (
                          <option key={value} value={value}>{label}</option>
                        ))}
                      </OverflowSafeSelect>
                      <span>{task?.status === "failed" ? task.error ?? "上传失败"
                        : task?.status === "cancelled" ? "已取消"
                        : `上传中 ${task?.progress ?? 0}%`}</span>
                      {task?.status === "failed" ? (
                        <button type="button" onClick={() => uploadManager?.retryTask(pending.taskId)}>重试</button>
                      ) : task?.status === "cancelled" ? (
                        <button type="button" onClick={() => {
                          uploadManager?.dismissTask(pending.taskId);
                          setPendingDocuments(current => current.filter(item => item.taskId !== pending.taskId));
                        }}>移除</button>
                      ) : (
                        <button type="button" onClick={() => {
                          uploadManager?.dismissTask(pending.taskId);
                          setPendingDocuments(current => current.filter(item => item.taskId !== pending.taskId));
                        }}>取消</button>
                      )}
                    </div>
                  ))}
                  <div className={styles.documentUploader}>
                    <AssetUploadPanel
                      productionId={productionId}
                      purpose="expense_document"
                      taskTarget={{ kind: "asset" }}
                      detachOnStart
                      onTaskStarted={task => setPendingDocuments(current => [...current, {
                        taskId: task.id,
                        fileName: task.fileName,
                        kind: "invoice",
                      }])}
                      onUploaded={result => setDocuments(current => [...current, {
                        id: result.fileId,
                        assetId: result.assetId,
                        assetFileId: result.fileId,
                        kind: "invoice",
                        fileName: result.fileName,
                        mimeType: null,
                      }])}
                    />
                  </div>
                </section>

                <label className={styles.field}>
                  <span>金额（元）</span>
                  <input
                    required
                    inputMode="decimal"
                    autoComplete="off"
                    pattern="[0-9]{1,12}([.][0-9]{1,2})?"
                    title="请输入最多两位小数的金额"
                    value={amount}
                    onChange={event => setAmount(event.target.value)}
                    placeholder="0.00"
                  />
                  <small>最多两位小数</small>
                </label>

                <label className={styles.field}>
                  <span>预算科目</span>
                  <OverflowSafeSelect value={categoryId} onChange={event => setCategoryId(event.target.value)}>
                    <option value="">暂不归类，由审批人确认</option>
                    {categories.map(category => (
                      <option key={category.id} value={category.id}>
                        {category.name}{category.deptName ? ` · ${category.deptName}` : ""}
                      </option>
                    ))}
                  </OverflowSafeSelect>
                </label>

                <label className={styles.field}>
                  <span>备注（可选）</span>
                  <textarea
                    rows={4}
                    value={note}
                    onChange={event => setNote(event.target.value)}
                    placeholder="补充用途、发生日期或其他说明"
                  />
                </label>
              </div>

              <div className={styles.footer}>
                {error && <p role="alert" className={styles.error}>{error}</p>}
                <div className={styles.footerButtons}>
                  <button type="button" className={styles.secondaryButton} disabled={saving} onClick={close}>取消</button>
                  <button type="submit" className={styles.primaryButton} disabled={saving || uploading}>
                    {saving ? "提交中…" : uploading ? "票据上传中…" : "提交报销"}
                  </button>
                </div>
              </div>
            </form>
          </aside>
        </div>
      )}
    </>
  );
}

async function openExpenseDocument(productionId: string, assetId: string, download: boolean) {
  const response = await fetch(
    `${BASE_PATH}/api/production/${productionId}/finance/expense-documents/${assetId}${download ? "?download=1" : ""}`,
  );
  if (!response.ok) {
    window.alert(await responseError(response, "凭证暂时无法打开"));
    return;
  }
  const data = await response.json() as { url?: string };
  if (data.url) window.open(data.url, "_blank", "noopener,noreferrer");
}

export function ExpenseDocumentLinks({ productionId, expenseId, documents }: {
  productionId: string;
  expenseId: string;
  documents: ExpenseDocumentView[];
}) {
  const uploadManager = useAssetUploadManager();
  const pending = (uploadManager?.tasks ?? []).filter(task =>
    task.productionId === productionId && task.target.kind === "expense" && task.target.expenseId === expenseId,
  ).filter(task => task.status !== "complete" || !task.result
    || !documents.some(document => document.assetFileId === task.result!.fileId));
  if (documents.length === 0 && pending.length === 0) return null;
  return (
    <div className={styles.documentLinks}>
      {documents.map(document => (
        <span key={document.id}>
          <b>{DOCUMENT_KIND_LABEL[document.kind]}</b>
          <button type="button" onClick={() => void openExpenseDocument(productionId, document.assetId, false)}>
            {document.fileName}
          </button>
          <button type="button" onClick={() => void openExpenseDocument(productionId, document.assetId, true)}>下载</button>
        </span>
      ))}
      {pending.map(task => (
        <span key={task.id}>
          <b>{DOCUMENT_KIND_LABEL[task.target.kind === "expense" ? task.target.documentKind : "other"]}</b>
          <span>{task.fileName}</span>
          <span>{task.status === "failed" ? task.error ?? "上传失败"
            : task.status === "binding" ? "正在关联"
            : task.status === "complete" ? "已关联"
            : task.status === "cancelled" ? "已取消"
            : `上传中 ${task.progress ?? 0}%`}</span>
          {task.status === "failed" ? (
            <button type="button" onClick={() => uploadManager?.retryTask(task.id)}>重试</button>
          ) : task.status === "complete" || task.status === "cancelled" ? (
            <button type="button" onClick={() => uploadManager?.dismissTask(task.id)}>移除</button>
          ) : (
            <button type="button" onClick={() => uploadManager?.cancelTask(task.id)}>取消</button>
          )}
        </span>
      ))}
    </div>
  );
}

export function ExpenseAddDocumentButton({ productionId, expenseId }: {
  productionId: string;
  expenseId: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<DocumentKind>("invoice");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [open]);

  async function attachFallback(result: { assetId: string; fileId: string }) {
    setError(null);
    const response = await fetch(
      `${BASE_PATH}/api/production/${productionId}/finance/expenses/${expenseId}/documents`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assetFileId: result.fileId, kind }),
      },
    );
    if (!response.ok) {
      await fetch(`${BASE_PATH}/api/production/${productionId}/finance/expense-documents/${result.assetId}`, {
        method: "DELETE",
      }).catch(() => {});
      setError(await responseError(response, "补充凭证失败"));
      return;
    }
    setOpen(false);
    router.refresh();
  }

  return (
    <>
      <button type="button" className={styles.documentAddButton} onClick={() => setOpen(true)}>
        补充凭证
      </button>
      {open && (
        <div className={`app-mobile-input-overlay ${styles.backdrop}`} role="presentation"
          onMouseDown={event => { if (event.target === event.currentTarget) setOpen(false); }}>
          <aside className={`app-mobile-input-overlay app-mobile-input-surface ${styles.documentDrawer}`}
            role="dialog" aria-modal="true" aria-labelledby={`expense-document-${expenseId}`}>
            <header className={styles.header}>
              <div><p>DOCUMENT</p><h2 id={`expense-document-${expenseId}`}>补充报销凭证</h2></div>
              <button type="button" className={styles.closeButton}
                onClick={() => setOpen(false)} aria-label="关闭补充凭证">×</button>
            </header>
            <div className={styles.documentAddBody}>
              <label className={styles.field}>
                <span>凭证类型</span>
                <OverflowSafeSelect value={kind} onChange={event => setKind(event.target.value as DocumentKind)}>
                  {Object.entries(DOCUMENT_KIND_LABEL).map(([value, label]) => (
                    <option key={value} value={value}>{label}</option>
                  ))}
                </OverflowSafeSelect>
              </label>
              <AssetUploadPanel
                productionId={productionId}
                purpose="expense_document"
                taskTarget={{ kind: "expense", expenseId, documentKind: kind }}
                detachOnStart
                onTaskStarted={() => setOpen(false)}
                onUploaded={result => void attachFallback(result)}
              />
              {error && <p role="alert" className={styles.error}>{error}</p>}
            </div>
          </aside>
        </div>
      )}
    </>
  );
}

export function ExpenseApprovalActions({ productionId, expenseId, canFinalize }: {
  productionId: string;
  expenseId: string;
  canFinalize: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<ExpenseAction | null>(null);
  const [confirmReject, setConfirmReject] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function act(action: ExpenseAction) {
    if (busy) return;
    setBusy(action);
    setError(null);
    try {
      const response = await fetch(`${BASE_PATH}/api/production/${productionId}/finance/expenses/${expenseId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      if (!response.ok) throw new Error(await responseError(response, "这笔报销处理失败"));
      router.refresh();
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : "这笔报销处理失败");
    } finally {
      setBusy(null);
      setConfirmReject(false);
    }
  }

  return (
    <div className={styles.approvalActions}>
      {confirmReject ? (
        <div className={styles.rejectConfirm}>
          <span>确认驳回？</span>
          <button type="button" disabled={busy !== null} onClick={() => setConfirmReject(false)}>取消</button>
          <button type="button" disabled={busy !== null} onClick={() => act("reject")}>
            {busy === "reject" ? "处理中…" : "确认驳回"}
          </button>
        </div>
      ) : (
        <div className={styles.actionButtons}>
          <button type="button" disabled={busy !== null} onClick={() => setConfirmReject(true)}>驳回</button>
          <button type="button" disabled={busy !== null} onClick={() => act("approve")}>
            {busy === "approve" ? "处理中…" : canFinalize ? "批准" : "向上转交"}
          </button>
        </div>
      )}
      {error && <small role="alert" className={styles.actionError}>{error}</small>}
    </div>
  );
}
