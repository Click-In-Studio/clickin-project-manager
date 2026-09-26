"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { BASE_PATH } from "@/lib/base-path";
import { PRIMARY_BTN } from "@/components/ui/PageHeader";
import OverflowSafeSelect from "@/components/ui/OverflowSafeSelect";
import styles from "./finance-expense-actions.module.css";

export type ExpenseCategoryOption = {
  id: string;
  name: string;
  deptName: string | null;
};

type ExpenseAction = "approve" | "reject";

async function responseError(response: Response, fallback: string) {
  const data = await response.json().catch(() => ({})) as { error?: string };
  return data.error ?? fallback;
}

export function ExpenseCreateButton({ productionId, categories }: {
  productionId: string;
  categories: ExpenseCategoryOption[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [amount, setAmount] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const resetForm = useCallback(() => {
    setOpen(false);
    setTitle("");
    setAmount("");
    setCategoryId("");
    setNote("");
    setError(null);
  }, []);

  const close = useCallback(() => {
    if (!saving) resetForm();
  }, [resetForm, saving]);

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
    if (saving) return;
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
          className={styles.backdrop}
          role="presentation"
          onMouseDown={event => { if (event.target === event.currentTarget) close(); }}
        >
          <aside className={styles.drawer} role="dialog" aria-modal="true" aria-labelledby="expense-create-title">
            <form onSubmit={submit} className={styles.form}>
              <header className={styles.header}>
                <div>
                  <p>REIMBURSEMENT</p>
                  <h2 id="expense-create-title">新建报销</h2>
                </div>
                <button type="button" className={styles.closeButton} onClick={close} aria-label="关闭报销单">×</button>
              </header>

              <p className={styles.lead}>填写实际垫付的费用。提交后会自动交给当前审批人处理。</p>

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
                  <button type="submit" className={styles.primaryButton} disabled={saving}>
                    {saving ? "提交中…" : "提交报销"}
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
