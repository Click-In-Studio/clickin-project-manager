"use client";

import { useMemo, useState } from "react";
import PageHeader, { PRIMARY_BTN, SECONDARY_BTN } from "@/components/ui/PageHeader";
import AdminModal from "@/components/ui/AdminModal";
import type { BudgetCategory, ExpenseCategory } from "@/lib/ops/finance-db";
import {
  CURRENCY_CODES, convertToBaseAmount, formatCurrencyLabel, formatMoney, isCurrencyCode,
  type CurrencyCode,
} from "@/lib/money";

type Caps = { categoryEdit: boolean; categoryCreate: boolean; categoryDelete: boolean; budgetEdit: boolean; budgetCreate: boolean; budgetDelete: boolean };
type Dept = { id: string; name: string };
type Modal = { kind: "category"; value?: ExpenseCategory } | { kind: "item"; value?: BudgetCategory } | null;
const FIELD = { width: "100%", border: "1px solid var(--line)", borderRadius: 8, padding: "9px 10px", background: "white", color: "var(--ink)" } as const;

export default function AdminFinanceClient({ productionId, productionName, baseCurrency: initialBaseCurrency, initialCategories, initialItems, depts, caps }: {
  productionId: string; productionName: string; baseCurrency: CurrencyCode; initialCategories: ExpenseCategory[]; initialItems: BudgetCategory[]; depts: Dept[]; caps: Caps;
}) {
  const [tab, setTab] = useState<"items" | "categories">("items");
  const [categories, setCategories] = useState(initialCategories);
  const [items, setItems] = useState(initialItems);
  const [baseCurrency, setBaseCurrency] = useState(initialBaseCurrency);
  const [modal, setModal] = useState<Modal>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const groups = useMemo(() => {
    const result = new Map<string, { name: string; items: BudgetCategory[] }>();
    for (const item of items) {
      const key = item.deptId ?? "public";
      const current = result.get(key) ?? { name: item.deptName ?? "项目公共", items: [] };
      current.items.push(item); result.set(key, current);
    }
    for (const group of result.values()) group.items.sort((a, b) => a.orderIndex - b.orderIndex || a.name.localeCompare(b.name, "zh-CN"));
    return [...result.entries()];
  }, [items]);

  async function request(path: string, method: string, body?: unknown) {
    setBusy(true); setError(null);
    try {
      const response = await fetch(`/api/production/${productionId}/finance/${path}`, {
        method, headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      const json = await response.json();
      if (!response.ok) throw new Error(json.error || "操作失败");
      return json;
    } finally { setBusy(false); }
  }

  async function removeCategory(category: ExpenseCategory) {
    if (!confirm(`删除费用科目“${category.name}”？`)) return;
    try { await request(`expense-categories/${category.id}`, "DELETE"); setCategories(v => v.filter(x => x.id !== category.id)); }
    catch (e) { setError(e instanceof Error ? e.message : "操作失败"); }
  }
  async function removeItem(item: BudgetCategory) {
    if (!confirm(`删除“${item.deptName ?? "项目公共"} · ${item.name}”预算项？历史报销会保留并变为未归类。`)) return;
    try { await request(`budget-items/${item.id}`, "DELETE"); setItems(v => v.filter(x => x.id !== item.id)); }
    catch (e) { setError(e instanceof Error ? e.message : "操作失败"); }
  }
  async function moveCategory(index: number, delta: -1 | 1) {
    const otherIndex = index + delta;
    if (!categories[otherIndex]) return;
    const current = categories[index], other = categories[otherIndex];
    try {
      const [a, b] = await Promise.all([
        request(`expense-categories/${current.id}`, "PATCH", { name: current.name, sortOrder: otherIndex }),
        request(`expense-categories/${other.id}`, "PATCH", { name: other.name, sortOrder: index }),
      ]);
      setCategories(v => v.map(x => x.id === a.category.id ? a.category : x.id === b.category.id ? b.category : x)
        .sort((x, y) => x.sortOrder - y.sortOrder || x.name.localeCompare(y.name, "zh-CN")));
    } catch (e) { setError(e instanceof Error ? e.message : "排序失败"); }
  }
  async function moveItem(groupItems: BudgetCategory[], index: number, delta: -1 | 1) {
    const otherIndex = index + delta;
    if (!groupItems[otherIndex]) return;
    const current = groupItems[index], other = groupItems[otherIndex];
    try {
      const [a, b] = await Promise.all([
        request(`budget-items/${current.id}`, "PATCH", { orderIndex: otherIndex }),
        request(`budget-items/${other.id}`, "PATCH", { orderIndex: index }),
      ]);
      setItems(v => v.map(x => x.id === a.item.id ? a.item : x.id === b.item.id ? b.item : x));
    } catch (e) { setError(e instanceof Error ? e.message : "排序失败"); }
  }

  return <main style={{ padding: "24px clamp(18px, 3vw, 52px) 60px", minHeight: "100vh", background: "var(--paper)" }}>
    <PageHeader eyebrow={productionName} title="财务设置" side="stage"
      actions={(tab === "items" ? caps.budgetCreate : caps.categoryCreate) ? <button style={PRIMARY_BTN} onClick={() => setModal({ kind: tab === "items" ? "item" : "category" })}>新增{tab === "items" ? "预算项" : "费用科目"}</button> : null} />
    <div style={{ display: "flex", gap: 4, borderBottom: "1px solid var(--line)", marginBottom: 20 }}>
      {([['items', '预算项'], ['categories', '费用科目']] as const).map(([key, label]) => <button key={key} onClick={() => setTab(key)} style={{ border: 0, borderBottom: tab === key ? "2px solid var(--stage)" : "2px solid transparent", padding: "10px 16px", background: "transparent", color: tab === key ? "var(--ink)" : "var(--muted)", fontWeight: 700, cursor: "pointer" }}>{label}</button>)}
    </div>
    {error && <p style={{ color: "#a33", fontSize: 12 }}>{error}</p>}
    <section style={{ border: "1px solid var(--line)", borderRadius: 10, padding: 16, marginBottom: 20, background: "white" }}>
      <strong style={{ display: "block", fontSize: 13, marginBottom: 5 }}>项目记账本位币</strong>
      <p style={{ margin: "0 0 10px", color: "var(--muted)", fontSize: 11 }}>所有预算汇总都会折算成这个币种。出现预算额度或已提交报销后不可修改。</p>
      <select style={{ ...FIELD, width: 180 }} value={baseCurrency} disabled={!caps.budgetEdit || busy} onChange={async event => {
        const next = event.target.value;
        try {
          const json = await request("settings", "PATCH", { baseCurrency: next });
          const saved = json.baseCurrency as CurrencyCode;
          setBaseCurrency(saved);
          setItems(current => current.map(item => item.amount === null
            ? { ...item, currency: saved, baseCurrency: saved } : item));
        } catch (e) { setError(e instanceof Error ? e.message : "本位币保存失败"); }
      }}>
        {CURRENCY_CODES.map(code => <option key={code} value={code}>{formatCurrencyLabel(code)}</option>)}
      </select>
    </section>
    {tab === "items" ? <div style={{ display: "grid", gap: 18 }}>
      {groups.length === 0 && <Empty text="还没有预算项" />}
      {groups.map(([key, group]) => <section key={key}>
        <h2 style={{ fontSize: 12, margin: "0 0 8px", color: "var(--muted)" }}>{group.name}</h2>
        <div style={{ border: "1px solid var(--line)", borderRadius: 10, overflow: "hidden", background: "white" }}>
          {group.items.map((item, index) => <div key={item.id} style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", padding: "13px 15px", borderTop: group.items[0] === item ? 0 : "1px solid var(--line)" }}>
            <strong style={{ flex: 1, fontSize: 13 }}>{item.name}</strong>
            <span style={{ fontSize: 12, color: "var(--muted)" }}>{item.amount === null ? "无上限" : moneyLabel(item)}</span>
            {caps.budgetEdit && <><button style={SECONDARY_BTN} disabled={index === 0 || busy} onClick={() => moveItem(group.items, index, -1)}>上移</button><button style={SECONDARY_BTN} disabled={index === group.items.length - 1 || busy} onClick={() => moveItem(group.items, index, 1)}>下移</button></>}
            {caps.budgetEdit && <button style={SECONDARY_BTN} onClick={() => setModal({ kind: "item", value: item })}>编辑</button>}
            {caps.budgetDelete && <button style={SECONDARY_BTN} onClick={() => removeItem(item)}>删除</button>}
          </div>)}
        </div>
      </section>)}
    </div> : <div style={{ border: "1px solid var(--line)", borderRadius: 10, overflow: "hidden", background: "white" }}>
      {categories.length === 0 && <Empty text="还没有费用科目" />}
      {categories.map((category, index) => <div key={category.id} style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", padding: "13px 15px", borderTop: categories[0] === category ? 0 : "1px solid var(--line)" }}>
        <div style={{ flex: 1 }}><strong style={{ fontSize: 13 }}>{category.name}</strong>{category.description && <p style={{ margin: "3px 0 0", fontSize: 11, color: "var(--muted)" }}>{category.description}</p>}</div>
        <span style={{ fontSize: 11, color: "var(--muted)" }}>{category.budgetItemCount} 个预算项</span>
        {caps.categoryEdit && <><button style={SECONDARY_BTN} disabled={index === 0 || busy} onClick={() => moveCategory(index, -1)}>上移</button><button style={SECONDARY_BTN} disabled={index === categories.length - 1 || busy} onClick={() => moveCategory(index, 1)}>下移</button></>}
        {caps.categoryEdit && <button style={SECONDARY_BTN} onClick={() => setModal({ kind: "category", value: category })}>编辑</button>}
        {caps.categoryDelete && <button style={SECONDARY_BTN} onClick={() => removeCategory(category)}>删除</button>}
      </div>)}
    </div>}
    {modal?.kind === "category" && <CategoryModal value={modal.value} busy={busy} onClose={() => setModal(null)} onSave={async body => {
      try { const json = await request(`expense-categories${modal.value ? `/${modal.value.id}` : ""}`, modal.value ? "PATCH" : "POST", body);
        setCategories(v => modal.value ? v.map(x => x.id === json.category.id ? json.category : x) : [...v, json.category]); setModal(null);
      } catch (e) { setError(e instanceof Error ? e.message : "操作失败"); }
    }} />}
    {modal?.kind === "item" && <ItemModal value={modal.value} baseCurrency={baseCurrency} categories={categories} depts={depts} busy={busy} onClose={() => setModal(null)} onSave={async body => {
      try { const json = await request(`budget-items${modal.value ? `/${modal.value.id}` : ""}`, modal.value ? "PATCH" : "POST", body);
        setItems(v => modal.value ? v.map(x => x.id === json.item.id ? json.item : x) : [...v, json.item]); setModal(null);
      } catch (e) { setError(e instanceof Error ? e.message : "操作失败"); }
    }} />}
  </main>;
}

function Empty({ text }: { text: string }) { return <p style={{ padding: 28, textAlign: "center", color: "var(--muted)", fontSize: 12 }}>{text}</p>; }
function moneyLabel(item: BudgetCategory) {
  if (item.amount === null || !isCurrencyCode(item.currency) || !isCurrencyCode(item.baseCurrency)) return item.amount ?? "无上限";
  const original = formatMoney(item.amount, item.currency);
  return item.currency === item.baseCurrency || item.baseAmount === null
    ? original : `${original} → ${formatMoney(item.baseAmount, item.baseCurrency)}`;
}
function CategoryModal({ value, busy, onClose, onSave }: { value?: ExpenseCategory; busy: boolean; onClose: () => void; onSave: (body: object) => void }) {
  const [name, setName] = useState(value?.name ?? ""); const [description, setDescription] = useState(value?.description ?? "");
  return <AdminModal title={value ? "编辑费用科目" : "新增费用科目"} onClose={onClose}><form onSubmit={e => { e.preventDefault(); onSave({ name, description }); }} style={{ display: "grid", gap: 12 }}>
    <label>名称<input style={FIELD} value={name} onChange={e => setName(e.target.value)} required /></label>
    <label>说明<input style={FIELD} value={description} onChange={e => setDescription(e.target.value)} /></label>
    <button style={PRIMARY_BTN} disabled={busy}>保存</button>
  </form></AdminModal>;
}
function ItemModal({ value, baseCurrency, categories, depts, busy, onClose, onSave }: { value?: BudgetCategory; baseCurrency: CurrencyCode; categories: ExpenseCategory[]; depts: Dept[]; busy: boolean; onClose: () => void; onSave: (body: object) => void }) {
  const [categoryId, setCategoryId] = useState(value?.categoryId ?? categories[0]?.id ?? "");
  const [deptId, setDeptId] = useState(value?.deptId ?? "");
  const [amount, setAmount] = useState(value?.amount ?? "");
  const [currency, setCurrency] = useState<CurrencyCode>(isCurrencyCode(value?.currency) ? value.currency : baseCurrency);
  const [exchangeRate, setExchangeRate] = useState(value?.exchangeRate ?? "");
  const [exchangeRateDate, setExchangeRateDate] = useState(value?.exchangeRateDate ?? "");
  const [exchangeRateSource, setExchangeRateSource] = useState(value?.exchangeRateSource ?? "");
  const [notes, setNotes] = useState(value?.notes ?? "");
  const converted = amount && currency !== baseCurrency
    ? convertToBaseAmount(amount, exchangeRate, baseCurrency) : null;
  return <AdminModal title={value ? "编辑预算项" : "新增预算项"} onClose={onClose}><form onSubmit={e => { e.preventDefault(); onSave({
    categoryId, deptId: deptId || null, amount: amount || null, currency: amount ? currency : baseCurrency,
    exchangeRate: !amount || currency === baseCurrency ? null : exchangeRate,
    exchangeRateDate: !amount || currency === baseCurrency ? null : exchangeRateDate,
    exchangeRateSource: !amount || currency === baseCurrency ? null : exchangeRateSource,
    notes,
  }); }} style={{ display: "grid", gap: 12 }}>
    <label>费用科目<select style={FIELD} value={categoryId} onChange={e => setCategoryId(e.target.value)} disabled={!!value} required>{categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
    <label>负责部门<select style={FIELD} value={deptId} onChange={e => setDeptId(e.target.value)}><option value="">项目公共</option>{depts.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}</select></label>
    <label>预算币种<select style={FIELD} value={currency} onChange={e => setCurrency(e.target.value as CurrencyCode)}>{CURRENCY_CODES.map(code => <option key={code}>{formatCurrencyLabel(code)}</option>)}</select></label>
    <label>预算上限 · {formatCurrencyLabel(currency)}<input style={FIELD} inputMode="decimal" value={amount} onChange={e => setAmount(e.target.value)} placeholder="留空表示无上限" /></label>
    {amount && currency !== baseCurrency && <>
      <label>人工汇率<span style={{ display: "block", color: "var(--muted)", fontSize: 10 }}>1 {formatCurrencyLabel(currency)} = 多少 {formatCurrencyLabel(baseCurrency)}</span><input style={FIELD} inputMode="decimal" value={exchangeRate} onChange={e => setExchangeRate(e.target.value)} required /></label>
      <label>汇率日期<input style={FIELD} type="date" value={exchangeRateDate} onChange={e => setExchangeRateDate(e.target.value)} required /></label>
      <label>汇率来源<input style={FIELD} value={exchangeRateSource} onChange={e => setExchangeRateSource(e.target.value)} placeholder="例如：信用卡账单、银行结算单" maxLength={200} required /></label>
      <p style={{ margin: 0, fontSize: 11, color: "var(--muted)" }}>折算后：{converted ? formatMoney(converted, baseCurrency) : "请填写有效汇率"}</p>
    </>}
    <label>备注<input style={FIELD} value={notes} onChange={e => setNotes(e.target.value)} /></label>
    <button style={PRIMARY_BTN} disabled={busy || !categoryId}>保存</button>
  </form></AdminModal>;
}
