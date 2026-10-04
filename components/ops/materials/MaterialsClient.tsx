"use client";

import { useMemo, useState } from "react";
import Image from "next/image";
import ProductionModuleTopMenu, {
  PRODUCTION_MODULE_ACTION_CLASS,
  PRODUCTION_MODULE_OVERFLOW_ACTION_CLASS,
  PRODUCTION_MODULE_SECONDARY_ACTION_CLASS,
} from "@/components/shell/ProductionModuleTopMenu";
import type {
  MaterialCapabilitiesResponse, MaterialDetailResponse, MaterialListItem, MaterialLotView,
  MaterialOverview, MaterialOverviewKey,
} from "@/lib/ops/material-client-types";
import type { MaterialIdentifier } from "@/lib/ops/material-identifier-types";
import MaterialScanner, { type MaterialScanEntry } from "./MaterialScanner";
import styles from "./materials.module.css";

type Editor = "create" | "edit" | "lot" | null;
type Action = "receipt" | "checkout" | "return" | "damage" | "repair" | "exit" | "adjust_add" | "adjust_remove" | "source_return" | "cancel";
type BatchAction = "receipt" | "checkout" | "return" | "maintenance";

const trackingLabels = {
  serialized: "逐件跟踪", bulk_returnable: "批量可归还", consumable: "消耗品",
} as const;
const sourceLabels = { existing: "已有", purchased: "采购", produced: "自制", rented: "租赁", borrowed: "借用" } as const;
const bucketLabels: Record<string, string> = {
  expected: "待到货", in_stock: "在库", checked_out: "已签出", maintenance: "维修中",
  exited: "已退出", cancelled: "已取消", adjustment: "盘点调整",
};
const overviewLabels: Record<MaterialOverviewKey, string> = {
  pendingReceipt: "待入库", checkedOut: "已签出", maintenance: "维修中",
  overdueSourceReturn: "逾期归还", sourceException: "来源异常",
};

function errorMessage(data: unknown, fallback: string) {
  return data && typeof data === "object" && "error" in data && typeof data.error === "string"
    ? data.error : fallback;
}

function newKey() {
  return globalThis.crypto?.randomUUID?.() ?? `material-${Date.now()}-${Math.random()}`;
}

export default function MaterialsClient({ productionId, currentUserId, archived, initialMaterials, initialOverview, initialCapabilities }: {
  productionId: string; currentUserId: string; archived: boolean;
  initialMaterials: MaterialListItem[]; initialOverview: MaterialOverview;
  initialCapabilities: MaterialCapabilitiesResponse;
}) {
  const [materials, setMaterials] = useState(initialMaterials);
  const [overview, setOverview] = useState(initialOverview);
  const [overviewFilter, setOverviewFilter] = useState<MaterialOverviewKey | null>(null);
  const [capabilities, setCapabilities] = useState(initialCapabilities);
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<MaterialDetailResponse | null>(null);
  const [detailBusy, setDetailBusy] = useState(false);
  const [detailError, setDetailError] = useState("");
  const [editor, setEditor] = useState<Editor>(null);
  const [action, setAction] = useState<Action | null>(null);
  const [scanner, setScanner] = useState(false);
  const [scanEntries, setScanEntries] = useState<MaterialScanEntry[]>([]);
  const [identifierManager, setIdentifierManager] = useState(false);
  const [identifierPrefill, setIdentifierPrefill] = useState("");
  const [sourceException, setSourceException] = useState(false);
  const [prefilledLotId, setPrefilledLotId] = useState<string | null>(null);
  const [selectedLotId, setSelectedLotId] = useState<string | null>(null);
  const [batchSelection, setBatchSelection] = useState<string[]>([]);
  const [batchAction, setBatchAction] = useState<BatchAction | null>(null);
  const [receiptResult, setReceiptResult] = useState<MaterialIdentifier[]>([]);

  const visible = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    const filtered = overviewFilter
      ? materials.filter(item => overview[overviewFilter].materialIds.includes(item.id)) : materials;
    return needle ? filtered.filter(item => [item.number, item.name, item.category,
      item.departmentName, item.groupName, item.location].some(value => value?.toLocaleLowerCase().includes(needle))) : filtered;
  }, [materials, overview, overviewFilter, query]);

  async function reload(reopen = selectedId) {
    const response = await fetch(`/api/production/${productionId}/materials`);
    if (response.ok) {
      const data = await response.json() as { materials: MaterialListItem[]; overview: MaterialOverview; capabilities: MaterialCapabilitiesResponse };
      setMaterials(data.materials); setOverview(data.overview); setCapabilities(data.capabilities);
    }
    if (reopen) await openDetail(reopen);
  }

  async function openDetail(materialId: string) {
    if (materialId !== selectedId) { setSelectedLotId(null); setBatchSelection([]); }
    setSelectedId(materialId); setDetailBusy(true); setDetail(null); setDetailError("");
    try {
      const response = await fetch(`/api/production/${productionId}/materials/${materialId}`);
      const raw = await response.text();
      let data: unknown = {};
      if (raw) {
        try { data = JSON.parse(raw); }
        catch { data = { error: `详情接口返回了无法解析的内容（${response.status}）` }; }
      }
      if (response.ok && data && typeof data === "object" && "material" in data) {
        const next = data as MaterialDetailResponse;
        setDetail(next);
        const existingIds = new Set(next.lots.map(lot => lot.id));
        setBatchSelection(current => current.filter(id => existingIds.has(id)));
      }
      else setDetailError(errorMessage(data, `无法加载物料详情（${response.status}）`));
    } catch {
      setDetailError("无法连接服务器，请检查网络后重试。");
    } finally { setDetailBusy(false); }
  }

  async function deleteSelected() {
    if (!selectedId || !globalThis.confirm("确定删除这个尚无库存历史的物料类型？")) return;
    const response = await fetch(`/api/production/${productionId}/materials/${selectedId}`, { method: "DELETE" });
    if (!response.ok) return;
    setSelectedId(null); setDetail(null); await reload(null);
  }

  const canCreate = !archived && (capabilities.global.createDefinition
    || capabilities.representableSubjects.some(subject => subject.poc));
  const selectedMaterial = detail?.material ?? materials.find(item => item.id === selectedId) ?? null;
  const materialCaps = selectedMaterial ? capabilities.byMaterial[selectedMaterial.id] : null;
  const selectedLot = detail?.lots.find((lot) => lot.id === selectedLotId) ?? null;
  const serialized = selectedMaterial?.trackingStrategy === "serialized";
  const scopedLots = serialized ? (selectedLot ? [selectedLot] : []) : (detail?.lots ?? []);
  const selectedBatchLots = detail?.lots.filter(lot => batchSelection.includes(lot.id)) ?? [];
  const batchEnabled = (operation: BatchAction) => batchSelection.length > 0 && selectedBatchLots.every(lot => {
    const cap = capabilities.byLot[lot.id];
    if (!cap) return false;
    if (operation === "receipt") return lot.currentBucket === "expected" && cap.confirmReceipt;
    if (operation === "checkout") return lot.currentBucket === "in_stock" && cap.checkoutSelf;
    if (operation === "return") return lot.currentBucket === "checked_out" && (cap.returnOwn || cap.returnForOthers);
    return (lot.currentBucket === "in_stock" || lot.currentBucket === "checked_out")
      && (cap.manageMaintenance || cap.reportDamageInCustody);
  });
  const overviewKeys = Object.keys(overviewLabels) as MaterialOverviewKey[];

  const createButton = <button className={PRODUCTION_MODULE_ACTION_CLASS} disabled={!canCreate}
    title={canCreate ? "新增物料类型" : archived ? "项目已归档" : "你没有可负责的责任方或建档权限"}
    onClick={() => setEditor("create")}>新增物料类型</button>;
  const scanButton = <button className={PRODUCTION_MODULE_SECONDARY_ACTION_CLASS} onClick={() => setScanner(true)}>扫码</button>;

  return <>
    <ProductionModuleTopMenu label="物料台账"
      primaryAction={createButton} primaryShortAction={createButton}
      primaryOverflowAction={<button className={PRODUCTION_MODULE_OVERFLOW_ACTION_CLASS} disabled={!canCreate} onClick={() => setEditor("create")}>新增物料类型</button>}
      secondaryActions={scanButton}
      secondaryOverflowActions={<button className={PRODUCTION_MODULE_OVERFLOW_ACTION_CLASS} onClick={() => setScanner(true)}>扫描物料码</button>}
    />
    <main className={styles.page}>
      <div className={styles.toolbar}>
        <p className={styles.eyebrow}>道具 · 服装 · 设备</p>
        <div className={styles.actions}>
          <button className={styles.button} onClick={() => setScanner(true)}>扫码入库</button>
          <button className={styles.primary} disabled={!canCreate}
            title={canCreate ? "" : archived ? "项目已归档" : "需要物料建档权限，或成为某责任方 POC"}
            onClick={() => setEditor("create")}>新增物料类型</button>
        </div>
      </div>
      <div className={styles.metrics}>{overviewKeys.map(key => <button className={`${styles.metric} ${overviewFilter === key ? styles.metricActive : ""}`} key={key} aria-pressed={overviewFilter === key} onClick={() => setOverviewFilter(current => current === key ? null : key)}><strong>{overview[key].count}</strong><span>{overviewLabels[key]} · 实物/批次</span></button>)}</div>
      <div className={styles.filters}><input className={styles.search} value={query} onChange={e => setQuery(e.target.value)} placeholder="搜索编号、名称、分类、责任方或库位" /></div>
      {visible.length === 0 ? <div className={styles.empty}>
        <p>{materials.length ? "没有匹配的物料" : "还没有物料"}</p>
        <small>{materials.length ? overviewFilter ? `当前没有${overviewLabels[overviewFilter]}事项；点击总览卡可取消筛选` : "换个关键词试试" : canCreate ? "先登记物料类型，再确认实物或批次并登记入库" : "你当前没有可建档的责任方"}</small>
      </div> : <>
        <div className={styles.table}>
          <div className={`${styles.row} ${styles.rowHeader}`}><span>编号</span><span>名称</span><span>分类 / 跟踪</span><span>负责方</span><span>来源</span><span>库存 / 消耗 / 异常</span><span>库位</span><span>最近更新</span></div>
          {visible.map(item => <button className={styles.row} key={item.id} onClick={() => void openDetail(item.id)}>
            <code className={styles.number}>{item.number}</code><b className={styles.name}>{item.name}</b>
            <span>{item.category || "—"}<br /><small className={styles.muted}>{trackingLabels[item.trackingStrategy]}</small></span><span>{item.departmentName ?? item.groupName ?? "—"}</span><span>{item.sourceSummary || "—"}</span>
            <span className={styles.chips}>
              {item.expectedQuantity > 0 && <i className={styles.chip}>待到货 {item.expectedQuantity}{item.unit}</i>}
              <i className={styles.chip}>在库 {item.inStockQuantity}{item.unit}</i>
              {item.checkedOutQuantity > 0 && <i className={styles.chip}>签出 {item.checkedOutQuantity}{item.unit}</i>}
              {item.maintenanceQuantity > 0 && <i className={styles.chip}>维修 {item.maintenanceQuantity}{item.unit}</i>}
              {item.trackingStrategy === "consumable" && <i className={styles.chip}>净消耗 {item.netConsumedQuantity}{item.unit}</i>}
              {item.abnormalQuantity > 0 && <i className={styles.chip}>异常 {item.abnormalQuantity}{item.unit}</i>}
            </span><span className={styles.muted}>{item.location || "—"}</span><span className={styles.muted}>{new Date(item.updatedAt).toLocaleDateString("zh-CN")}</span>
          </button>)}
        </div>
        <div className={styles.mobileCards}>{visible.map(item => <button className={styles.mobileCard} key={item.id} onClick={() => void openDetail(item.id)}>
          <div className={styles.mobileCardTop}><span><code className={styles.number}>{item.number}</code><br /><b>{item.name}</b></span><span className={styles.muted}>{item.category || "未分类"}</span></div>
          <div className={styles.muted}>{trackingLabels[item.trackingStrategy]} · {item.departmentName ?? item.groupName ?? "无责任方"} · {item.sourceSummary || "未登记来源"}</div><div className={styles.chips}><i className={styles.chip}>在库 {item.inStockQuantity}{item.unit}</i>{item.expectedQuantity > 0 && <i className={styles.chip}>待到货 {item.expectedQuantity}{item.unit}</i>}{item.checkedOutQuantity > 0 && <i className={styles.chip}>签出 {item.checkedOutQuantity}{item.unit}</i>}{item.maintenanceQuantity > 0 && <i className={styles.chip}>维修 {item.maintenanceQuantity}{item.unit}</i>}{item.abnormalQuantity > 0 && <i className={styles.chip}>异常 {item.abnormalQuantity}{item.unit}</i>}</div>
        </button>)}</div>
      </>}
    </main>

    {selectedId && <>
      <div className={styles.backdrop} onClick={() => { setSelectedId(null); setDetail(null); }} />
      <aside className={styles.drawer} aria-label="物料详情">
        <header className={styles.drawerHeader}><div><code className={styles.number}>{selectedMaterial?.number}</code><h2>{selectedMaterial?.name ?? "加载中…"}</h2></div><button className={styles.button} onClick={() => { setSelectedId(null); setDetail(null); }}>关闭</button></header>
        <div className={styles.drawerBody}>{detailBusy ? <p className={styles.muted}>加载详情…</p>
          : detailError ? <div className={styles.error}>{detailError}<div className={styles.actions}><button className={styles.button} onClick={() => void openDetail(selectedId)}>重试</button></div></div>
          : detail ? <MaterialDetail detail={detail} selectedLotId={selectedLotId}
            batchSelection={batchSelection} onSelectLot={setSelectedLotId}
            onToggleBatch={lotId => setBatchSelection(current => current.includes(lotId)
              ? current.filter(id => id !== lotId) : [...current, lotId])}
            onSelectBatch={setBatchSelection} /> : null}</div>
        <div className={styles.drawerActions}>
          <div className={styles.actionGroup}>
            <span className={styles.actionGroupLabel}>日常流转</span>
            <div className={styles.actionGrid}>
              <button className={styles.button} disabled={!materialCaps?.confirmReceipt} title={!materialCaps?.confirmReceipt ? "需要责任方日常维护或收货权限" : ""} onClick={() => setEditor("lot")}>确认实物/批次</button>
              {serialized && <ActionButton label={batchSelection.length ? `批量入库 ${batchSelection.length}` : "批量入库"} enabled={batchEnabled("receipt")} reason="请选择状态均为待到货且可操作的编号" onClick={() => setBatchAction("receipt")} />}
              {serialized && <ActionButton label={batchSelection.length ? `批量签出 ${batchSelection.length}` : "批量签出"} enabled={batchEnabled("checkout")} reason="请选择状态均为在库且可操作的编号" onClick={() => setBatchAction("checkout")} />}
              {serialized && <ActionButton label={batchSelection.length ? `批量返库 ${batchSelection.length}` : "批量返库"} enabled={batchEnabled("return")} reason="请选择状态均为已签出且可操作的编号" onClick={() => setBatchAction("return")} />}
              {serialized && <ActionButton label={batchSelection.length ? `批量报修 ${batchSelection.length}` : "批量报修"} enabled={batchEnabled("maintenance")} reason="请选择状态均为在库或已签出且可操作的编号" onClick={() => setBatchAction("maintenance")} />}
              <ActionButton label="入库" enabled={scopedLots.some(l => capabilities.byLot[l.id]?.confirmReceipt)} reason={serialized ? "请先选择一个待到货编号" : "没有待入库数量或缺少收货权限"} onClick={() => { setPrefilledLotId(selectedLotId); setAction("receipt"); }} />
              <ActionButton label="签出" enabled={scopedLots.some(l => capabilities.byLot[l.id]?.checkoutSelf)} reason={serialized ? "请先选择一个在库编号" : "没有可签出库存"} onClick={() => { setPrefilledLotId(selectedLotId); setAction("checkout"); }} />
              <ActionButton label="返还" enabled={scopedLots.some(l => capabilities.byLot[l.id]?.returnOwn || capabilities.byLot[l.id]?.returnForOthers)} reason={serialized ? "请先选择一个已签出编号" : "没有可登记的返还"} onClick={() => { setPrefilledLotId(selectedLotId); setAction("return"); }} />
              <ActionButton label="报损/维修" enabled={scopedLots.some(l => capabilities.byLot[l.id]?.manageMaintenance || capabilities.byLot[l.id]?.reportDamageInCustody)} reason={serialized ? "请先选择一个可维护编号" : "没有可维护库存或权限不足"} onClick={() => { setPrefilledLotId(selectedLotId); setAction("damage"); }} />
              <ActionButton label="修复入库" enabled={scopedLots.some(l => capabilities.byLot[l.id]?.manageMaintenance && l.maintenanceQuantity > 0)} reason={serialized ? "请先选择一个维修中编号" : "没有维修中库存或权限不足"} onClick={() => { setPrefilledLotId(selectedLotId); setAction("repair"); }} />
            </div>
          </div>
          <div className={styles.actionGroup}>
            <span className={styles.actionGroupLabel}>类型与库存管理</span>
            <div className={styles.actionGrid}>
              <button className={styles.button} disabled={!materialCaps?.editDefinition} title={!materialCaps?.editDefinition ? "需要物料类型维护权限" : ""} onClick={() => setEditor("edit")}>编辑类型</button>
              <button className={styles.button} disabled={!materialCaps?.printLabels && !materialCaps?.manageIdentifiers || Boolean(serialized && !selectedLotId)} title={serialized && !selectedLotId ? "请先选择一个编号" : !materialCaps?.printLabels && !materialCaps?.manageIdentifiers ? "需要责任方日常维护或标识治理权限" : ""} onClick={() => setIdentifierManager(true)}>标识与标签</button>
              <ActionButton label="退出库存" enabled={scopedLots.some(l => capabilities.byLot[l.id]?.exitStock)} reason={serialized ? "请先选择一个可退出编号" : "需要库存退出权限"} onClick={() => { setPrefilledLotId(selectedLotId); setAction("exit"); }} />
              <ActionButton label="库存校正" enabled={scopedLots.some(l => capabilities.byLot[l.id]?.adjustStock)} reason={serialized ? "请先选择一个编号" : "需要库存调整权限"} onClick={() => { setPrefilledLotId(selectedLotId); setAction("adjust_add"); }} />
              <ActionButton label="退还来源" enabled={scopedLots.some(l => capabilities.byLot[l.id]?.returnToSource)} reason={serialized ? "请先选择一个可退还来源的编号" : "仅租赁/借用且需来源维护与库存退出权限"} onClick={() => { setPrefilledLotId(selectedLotId); setAction("source_return"); }} />
              <ActionButton label="来源异常" enabled={Boolean(materialCaps?.manageSources && detail?.lots.some(l => l.sourceType === "rented" || l.sourceType === "borrowed"))} reason="仅租赁/借用批次的来源维护人可登记" onClick={() => setSourceException(true)} />
              <button className={styles.danger} disabled={!materialCaps?.deleteDefinition} title={!materialCaps?.deleteDefinition ? "已有库存历史或缺少删除权限" : ""} onClick={() => void deleteSelected()}>删除类型</button>
            </div>
          </div>
        </div>
      </aside>
    </>}

    {editor && <MaterialEditor mode={editor} productionId={productionId} material={selectedMaterial}
      subjects={capabilities.representableSubjects} onClose={() => setEditor(null)} onSaved={async (materialId, identifiers) => {
        setEditor(null); if (identifiers?.length) setReceiptResult(identifiers); await reload(materialId ?? selectedId);
      }} />}
    {action && detail && <MovementDialog action={action} productionId={productionId} currentUserId={currentUserId}
      detail={detail} capabilities={capabilities} prefilledLotId={prefilledLotId}
      onClose={() => { setAction(null); setPrefilledLotId(null); }} onSaved={async () => {
        setAction(null); setPrefilledLotId(null); await reload(selectedId);
      }} />}
    {scanner && <MaterialScanner productionId={productionId} initialEntries={scanEntries} onEntriesChange={setScanEntries}
      onClose={() => setScanner(false)} onUnknown={detail && materialCaps?.manageIdentifiers ? code => {
      setScanner(false); setIdentifierPrefill(code); setIdentifierManager(true);
    } : undefined} onResolved={result => {
      setScanner(false); setPrefilledLotId(result.identifier.lotId); void openDetail(result.identifier.materialId).then(() => {
        if (result.identifier.lotId && result.currentBucket === "expected") setAction("receipt");
        if (result.identifier.lotId && result.currentBucket === "checked_out") setAction("return");
      });
    }} />}
    {identifierManager && detail && <IdentifierDialog productionId={productionId} detail={detail} initialValue={identifierPrefill}
      initialLotId={selectedLotId} canManage={Boolean(materialCaps?.manageIdentifiers)}
      onClose={() => { setIdentifierManager(false); setIdentifierPrefill(""); }} onSaved={async () => { setIdentifierManager(false); setIdentifierPrefill(""); await reload(selectedId); }} />}
    {sourceException && detail && <SourceExceptionDialog productionId={productionId} detail={detail}
      onClose={() => setSourceException(false)} onSaved={async () => { setSourceException(false); await reload(selectedId); }} />}
    {batchAction && detail && <BatchMovementDialog productionId={productionId} currentUserId={currentUserId}
      action={batchAction} detail={detail} lotIds={batchSelection}
      onClose={() => setBatchAction(null)} onSaved={async identifiers => {
        setBatchAction(null); setBatchSelection([]); if (identifiers.length) setReceiptResult(identifiers);
        await reload(selectedId);
      }} />}
    {receiptResult.length > 0 && <ReceiptResultDialog productionId={productionId} identifiers={receiptResult} onClose={() => setReceiptResult([])} />}
  </>;
}

function SourceExceptionDialog({ productionId, detail, onClose, onSaved }: {
  productionId: string; detail: MaterialDetailResponse; onClose(): void; onSaved(): void | Promise<void>;
}) {
  const lots = detail.lots.filter(lot => lot.sourceType === "rented" || lot.sourceType === "borrowed");
  const [lotId, setLotId] = useState(lots[0]?.id ?? ""); const [kind, setKind] = useState("lost");
  const [quantity, setQuantity] = useState("1"); const [note, setNote] = useState("");
  const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true); setError("");
    try {
      const response = await fetch(`/api/production/${productionId}/materials/${detail.material.id}/lots/${lotId}/source-exceptions`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind, quantity: Number(quantity), note }),
      });
      const data = await response.json();
      if (!response.ok) { setError(errorMessage(data, "登记失败")); return; }
      await onSaved();
    } catch { setError("网络状态不确定，请核对异常列表后再重试。"); }
    finally { setBusy(false); }
  }
  return <div className={styles.modalBackdrop}><section className={styles.modal} role="dialog" aria-modal="true"><header><h2>登记来源异常</h2><button className={styles.button} onClick={onClose}>关闭</button></header><div className={styles.form}>
    <label className={styles.field}>租借批次<select value={lotId} onChange={e => setLotId(e.target.value)}>{lots.map(lot => <option value={lot.id} key={lot.id}>{detail.identifiers.find(x => x.lotId === lot.id && x.kind === "internal_code")?.displayValue ?? lot.id} · {lot.sourceLabel}</option>)}</select></label>
    <div className={styles.formGrid}><label className={styles.field}>异常类型<select value={kind} onChange={e => setKind(e.target.value)}><option value="lost">遗失</option><option value="damaged">损坏</option><option value="short">少件</option></select></label><label className={styles.field}>数量<input type="number" min="0" step={10 ** -detail.material.quantityScale} value={quantity} onChange={e => setQuantity(e.target.value)} /></label></div>
    <label className={styles.field}>说明<textarea rows={3} value={note} onChange={e => setNote(e.target.value)} /></label>
    {error && <div className={styles.error}>{error}</div>}<div className={styles.formFooter}><button className={styles.button} onClick={onClose}>取消</button><button className={styles.primary} disabled={busy || !lotId || Number(quantity) <= 0} onClick={() => void save()}>{busy ? "登记中…" : "确认登记"}</button></div>
  </div></section></div>;
}

function IdentifierDialog({ productionId, detail, initialValue, initialLotId, canManage, onClose, onSaved }: {
  productionId: string; detail: MaterialDetailResponse; initialValue: string;
  initialLotId: string | null; canManage: boolean; onClose(): void; onSaved(): void | Promise<void>;
}) {
  const [lotId, setLotId] = useState(initialLotId ?? detail.lots[0]?.id ?? "");
  const [type, setType] = useState("existing_barcode"); const [value, setValue] = useState(initialValue);
  const [label, setLabel] = useState(""); const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  const internal = detail.identifiers.filter(item => item.kind === "internal_code" && item.isActive);
  const selectedInternal = internal.find(item => item.lotId === lotId);
  async function save() {
    setBusy(true); setError("");
    try {
      const response = await fetch(`/api/production/${productionId}/materials/${detail.material.id}/lots/${lotId}/identifiers`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type, value, label }),
      });
      const data = await response.json();
      if (!response.ok) { setError(errorMessage(data, "绑定失败")); return; }
      await onSaved();
    } catch { setError("网络状态不确定，请核对标识列表后再重试。"); }
    finally { setBusy(false); }
  }
  async function printLabels() {
    const targets = initialLotId && selectedInternal ? [selectedInternal] : internal;
    const target = window.open("", "_blank");
    if (!target) { setError("浏览器阻止了打印窗口，请允许弹出窗口后重试。"); return; }
    const response = await fetch(`/api/production/${productionId}/material-identifiers/labels`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identifierIds: targets.map(item => item.id), type: "code128", size: "medium", output: "print" }),
    });
    if (!response.ok) { target.close(); setError(errorMessage(await response.json(), "无法生成打印页")); return; }
    target.document.open(); target.document.write(await response.text()); target.document.close();
  }
  return <div className={styles.modalBackdrop}><section className={styles.modal} role="dialog" aria-modal="true"><header><h2>标识与标签</h2><button className={styles.button} onClick={onClose}>关闭</button></header><div className={styles.form}>
    <div className={styles.notice}>内部码用于 Click-In 寻址；外部码可绑定已有条码、厂商序列号或来源资产号。</div>
    {detail.lots.length > 0 && <>{initialLotId ? <div className={styles.notice}>当前编号：{selectedInternal?.displayValue ?? lotId}</div> : <label className={styles.field}>实物或批次<select value={lotId} onChange={e => setLotId(e.target.value)}>{detail.lots.map(lot => <option key={lot.id} value={lot.id}>{internal.find(x => x.lotId === lot.id)?.displayValue ?? lot.id}</option>)}</select></label>}
      {selectedInternal ? <section className={styles.labelSection}>
        <div className={styles.labelSectionHeader}><div><small>内部码</small><b>{selectedInternal.displayValue}</b></div><button className={styles.button} onClick={() => void printLabels()}>{initialLotId ? "打印此编号" : internal.length > 1 ? "打印全部条码" : "打印条码"}</button></div>
        <div className={styles.labelPreviewGrid}>
          <a className={styles.labelPreview} aria-label={`下载 ${selectedInternal.displayValue} 二维码`} href={`/api/production/${productionId}/material-identifiers/${selectedInternal.id}/image?type=qr&format=svg&download=1`}>
            <Image unoptimized src={`/api/production/${productionId}/material-identifiers/${selectedInternal.id}/image?type=qr&format=svg&size=medium`} alt={`${selectedInternal.displayValue} 二维码`} width={220} height={220} />
            <span>二维码<small>点击图片下载</small></span>
          </a>
          <a className={styles.labelPreview} aria-label={`下载 ${selectedInternal.displayValue} 可读条码`} href={`/api/production/${productionId}/material-identifiers/${selectedInternal.id}/image?type=code128&format=svg&download=1`}>
            <Image unoptimized src={`/api/production/${productionId}/material-identifiers/${selectedInternal.id}/image?type=code128&format=svg&size=medium`} alt={`${selectedInternal.displayValue} 可读条码`} width={320} height={160} />
            <span>可读条码<small>点击图片下载</small></span>
          </a>
        </div>
      </section> : <div className={styles.notice}>这个实物或批次还没有可用的内部码。</div>}
      {canManage && <><div className={styles.formGrid}><label className={styles.field}>外部码类型<select value={type} onChange={e => setType(e.target.value)}><option value="existing_barcode">已有条码</option><option value="manufacturer_serial">厂商序列号</option><option value="source_asset">来源资产号</option><option value="other">其他</option></select></label><label className={styles.field}>标签<input value={label} onChange={e => setLabel(e.target.value)} /></label></div><label className={styles.field}>码值<input value={value} onChange={e => setValue(e.target.value)} /></label></>}</>}
    {error && <div className={styles.error}>{error}</div>}<div className={styles.formFooter}><button className={styles.button} onClick={onClose}>关闭</button>{canManage && <button className={styles.primary} disabled={busy || !lotId || !value.trim()} onClick={() => void save()}>{busy ? "绑定中…" : "绑定外部码"}</button>}</div>
  </div></section></div>;
}

function BatchMovementDialog({ productionId, currentUserId, action, detail, lotIds, onClose, onSaved }: {
  productionId: string; currentUserId: string; action: BatchAction; detail: MaterialDetailResponse;
  lotIds: string[]; onClose(): void; onSaved(identifiers: MaterialIdentifier[]): void | Promise<void>;
}) {
  const [checkoutSelf, setCheckoutSelf] = useState(true);
  const [custodianLabel, setCustodianLabel] = useState("");
  const [toLocation, setToLocation] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [idempotencyKey] = useState(newKey);
  const titles: Record<BatchAction, string> = {
    receipt: "批量入库", checkout: "批量签出", return: "批量返库", maintenance: "批量报修",
  };
  const selectedLots = detail.lots.filter(lot => lotIds.includes(lot.id));
  const checkoutFor = (lotId: string) => detail.checkouts.find(checkout =>
    checkout.lotId === lotId && checkout.outstandingQuantity > 0);
  const canCheckoutForOthers = selectedLots.every(lot => detail.capabilities.byLot[lot.id]?.checkoutForOthers);
  async function save() {
    const items = selectedLots.map(lot => ({
      lotId: lot.id, fromBucket: lot.currentBucket,
      returnOfMovementId: lot.currentBucket === "checked_out" ? checkoutFor(lot.id)?.movementId ?? null : null,
    }));
    if (items.some(item => !item.fromBucket
        || ((action === "return" || action === "maintenance") && item.fromBucket === "checked_out" && !item.returnOfMovementId))) {
      setError("所选实物缺少有效的原签出记录，请刷新详情后重试。"); return;
    }
    setBusy(true); setError("");
    try {
      const body = { operation: action, items, reason, toLocation, idempotencyKey,
        custodian: action === "checkout" && checkoutSelf ? { kind: "user", id: currentUserId } : null,
        custodianLabel: action === "checkout" ? checkoutSelf ? "本人" : custodianLabel : "" };
      const response = await fetch(`/api/production/${productionId}/materials/${detail.material.id}/movements/batch`, {
        method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
        body: JSON.stringify(body),
      });
      const raw = await response.text();
      const data = raw ? JSON.parse(raw) as { error?: string; identifiers?: MaterialIdentifier[] } : {};
      if (!response.ok) { setError(data.error ?? `${titles[action]}失败`); return; }
      await onSaved(data.identifiers ?? []);
    } catch { setError("网络状态不确定。请保留当前表单并用同一按钮重试，不要重新发起一批操作。"); }
    finally { setBusy(false); }
  }
  return <div className={styles.modalBackdrop}><section className={styles.modal} role="dialog" aria-modal="true"><header><h2>{titles[action]} · {selectedLots.length} 件</h2><button className={styles.button} onClick={onClose}>关闭</button></header><div className={styles.form}>
    <div className={styles.notice}>本次操作会同时登记所选编号；任一件状态或权限不符，整批都不会写入。</div>
    {action === "checkout" && <><label className={styles.field}>登记方式<select value={checkoutSelf ? "self" : "other"} onChange={event => setCheckoutSelf(event.target.value === "self")}><option value="self">本人签出</option><option value="other" disabled={!canCheckoutForOthers}>代他人或外部经手</option></select></label>{!checkoutSelf && <label className={styles.field}>经手对象或去向<input value={custodianLabel} onChange={event => setCustodianLabel(event.target.value)} /></label>}</>}
    <label className={styles.field}>{action === "checkout" ? "去向" : "目标库位"}<input value={toLocation} onChange={event => setToLocation(event.target.value)} placeholder="选填" /></label>
    <label className={styles.field}>原因或备注<textarea rows={3} value={reason} onChange={event => setReason(event.target.value)} /></label>
    {error && <div className={styles.error}>{error}</div>}<div className={styles.formFooter}><button className={styles.button} onClick={onClose}>取消</button><button className={styles.primary} disabled={busy || selectedLots.length === 0 || (action === "checkout" && !checkoutSelf && !custodianLabel.trim())} onClick={() => void save()}>{busy ? "登记中…" : `确认${titles[action]}`}</button></div>
  </div></section></div>;
}

function ReceiptResultDialog({ productionId, identifiers, onClose }: {
  productionId: string; identifiers: MaterialIdentifier[]; onClose(): void;
}) {
  const internal = identifiers.filter(item => item.kind === "internal_code" && item.isActive);
  const [error, setError] = useState("");
  async function printAll() {
    const target = window.open("", "_blank");
    if (!target) { setError("浏览器阻止了打印窗口，请允许弹出窗口后重试。"); return; }
    const response = await fetch(`/api/production/${productionId}/material-identifiers/labels`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identifierIds: internal.map(item => item.id), type: "code128", size: "medium", output: "print" }),
    });
    if (!response.ok) { target.close(); setError(errorMessage(await response.json(), "无法生成打印页")); return; }
    target.document.open(); target.document.write(await response.text()); target.document.close();
  }
  return <div className={styles.modalBackdrop}><section className={styles.modal} role="dialog" aria-modal="true"><header><h2>入库完成 · {internal.length} 个编号</h2><button className={styles.button} onClick={onClose}>关闭</button></header><div className={styles.form}>
    <div className={styles.resultCodes}>{internal.map(item => <div key={item.id}><code>{item.displayValue}</code><a href={`/api/production/${productionId}/material-identifiers/${item.id}/image?type=code128&format=svg&download=1`}>查看 / 下载条码</a></div>)}</div>
    {error && <div className={styles.error}>{error}</div>}<div className={styles.formFooter}><button className={styles.button} onClick={onClose}>稍后处理</button><button className={styles.primary} disabled={!internal.length} onClick={() => void printAll()}>打印全部标签</button></div>
  </div></section></div>;
}

function ActionButton({ label, enabled, reason, onClick }: { label: string; enabled: boolean; reason: string; onClick(): void }) {
  return <button className={styles.button} disabled={!enabled} aria-disabled={!enabled}
    aria-label={enabled ? label : `${label}：${reason}`} title={enabled ? "" : reason} onClick={onClick}>{label}</button>;
}

function MaterialDetail({ detail, selectedLotId, batchSelection, onSelectLot, onToggleBatch, onSelectBatch }: {
  detail: MaterialDetailResponse; selectedLotId: string | null; batchSelection: string[];
  onSelectLot(lotId: string): void; onToggleBatch(lotId: string): void; onSelectBatch(lotIds: string[]): void;
}) {
  const serialized = detail.material.trackingStrategy === "serialized";
  const movements = detail.lotDetails
    .filter(item => !serialized || !selectedLotId || item.lotId === selectedLotId)
    .flatMap(item => item.movements).sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
  const selectionGroups = [
    ["待到货", detail.lots.filter(lot => lot.currentBucket === "expected")],
    ["在库", detail.lots.filter(lot => lot.currentBucket === "in_stock")],
    ["已签出", detail.lots.filter(lot => lot.currentBucket === "checked_out")],
  ] as const;
  return <>
    <section className={styles.section}><h3>类型信息</h3><div className={styles.definition}>
      <div><small>分类</small>{detail.material.category || "—"}</div>
      <div><small>跟踪方式</small>{trackingLabels[detail.material.trackingStrategy]}</div>
      <div><small>责任方</small>{detail.material.departmentName ?? detail.material.groupName ?? "—"}</div>
      <div><small>单位与精度</small>{detail.material.unit} · {detail.material.quantityScale} 位小数</div>
      <div><small>消耗量</small>{detail.material.netConsumedQuantity}{detail.material.unit}</div>
      <div><small>最近更新</small>{new Date(detail.material.updatedAt).toLocaleString("zh-CN")}</div>
    </div>{detail.material.notes && <p className={styles.muted}>{detail.material.notes}</p>}</section>
    <section className={styles.section}><div className={styles.sectionTitle}><h3>实物与批次 · {detail.lots.length}</h3>{serialized && <div className={styles.selectionActions}>{selectionGroups.filter(([, lots]) => lots.length > 0).map(([label, lots]) => <button className={styles.button} key={label} onClick={() => onSelectBatch(lots.every(lot => batchSelection.includes(lot.id)) ? [] : lots.map(lot => lot.id))}>{lots.every(lot => batchSelection.includes(lot.id)) ? `取消${label}` : `全选${label} ${lots.length}`}</button>)}</div>}</div>
      {serialized && <p className={styles.muted}>点卡片选择要管理的单件；勾选多个编号后，可按共同状态批量入库、签出、返库或报修。</p>}
      {detail.lots.length === 0 ? <p className={styles.muted}>还没有确认批次</p> : detail.lots.map(lot => {
        const identifiers = detail.identifiers.filter(x => x.lotId === lot.id && x.isActive);
        const exceptions = detail.lotDetails.find(item => item.lotId === lot.id)?.sourceExceptions.filter(item => !item.isResolved) ?? [];
        const selectable = serialized && ["expected", "in_stock", "checked_out"].includes(lot.currentBucket ?? "");
        return <div className={`${styles.lot} ${serialized ? styles.serializedLot : ""} ${selectedLotId === lot.id ? styles.selectedLot : ""}`} key={lot.id} onClick={serialized ? () => onSelectLot(lot.id) : undefined}><div className={styles.lotTop}><span className={styles.itemIdentity}>{selectable && <input type="checkbox" aria-label="选择批量操作" checked={batchSelection.includes(lot.id)} onClick={event => event.stopPropagation()} onChange={() => onToggleBatch(lot.id)} />}{serialized ? <button className={styles.itemSelect} onClick={() => onSelectLot(lot.id)}><b>{identifiers.find(x => x.kind === "internal_code")?.displayValue ?? "实物"}</b><i className={styles.chip}>{bucketLabels[lot.currentBucket ?? ""] ?? "多状态"}</i></button> : <><b>{identifiers.find(x => x.kind === "internal_code")?.displayValue ?? "批次"}</b><i className={styles.chip}>{bucketLabels[lot.currentBucket ?? ""] ?? "多状态"}</i></>}</span><span className={styles.muted}>{sourceLabels[lot.sourceType]}{lot.sourceLabel ? ` · ${lot.sourceLabel}` : ""}</span></div>
          <div className={styles.lotGrid}><span>待到货 {lot.expectedQuantity}</span><span>在库 {lot.inStockQuantity}</span><span>签出 {lot.checkedOutQuantity}</span><span>维修 {lot.maintenanceQuantity}</span><span>退出 {lot.exitedQuantity}</span><span>库位 {lot.location || "—"}</span><span>确认 {lot.confirmedQuantity}</span><span>{lot.returnDueAt ? `应还 ${new Date(lot.returnDueAt).toLocaleDateString("zh-CN")}` : "无归还义务"}</span></div>
          {identifiers.filter(x => x.kind === "external").map(x => <div className={styles.muted} key={x.id}>外部码：{x.displayValue}</div>)}
          {exceptions.map(issue => <div className={styles.error} key={issue.id}>来源异常：{issue.kind} {issue.quantity}{detail.material.unit}{issue.note ? ` · ${issue.note}` : ""}</div>)}
        </div>;
      })}</section>
    <section className={styles.section}><h3>{serialized && selectedLotId ? "当前编号流转记录" : "流转记录"}</h3>{movements.length === 0 ? <p className={styles.muted}>{serialized && !selectedLotId ? "选择一个编号后可聚焦管理；下方暂显示全部记录" : "还没有流转"}</p> : <div className={styles.timeline}>{movements.map(m => <div className={styles.event} key={m.id}>
      <b>{bucketLabels[m.fromBucket]} → {bucketLabels[m.toBucket]} · {m.quantity}{detail.material.unit}</b><br />
      <span className={styles.muted}>{new Date(m.occurredAt).toLocaleString("zh-CN")}{m.reason ? ` · ${m.reason}` : ""}{m.custodianLabel ? ` · 经手 ${m.custodianLabel}` : ""}{m.toLocation ? ` · 去向 ${m.toLocation}` : ""}</span>
    </div>)}</div>}</section>
  </>;
}

function MaterialEditor({ mode, productionId, material, subjects, onClose, onSaved }: {
  mode: Editor; productionId: string; material: MaterialListItem | null;
  subjects: MaterialCapabilitiesResponse["representableSubjects"];
  onClose(): void; onSaved(materialId?: string, identifiers?: MaterialIdentifier[]): void | Promise<void>;
}) {
  const isLot = mode === "lot";
  const [name, setName] = useState(material?.name ?? "");
  const [category, setCategory] = useState(material?.category ?? "");
  const [tracking, setTracking] = useState(material?.trackingStrategy ?? "bulk_returnable");
  const [unit, setUnit] = useState(material?.unit ?? "件");
  const [scale, setScale] = useState(material?.quantityScale ?? 0);
  const defaultSubject = material?.departmentId ? `dept:${material.departmentId}` : material?.groupId ? `group:${material.groupId}` : "";
  const [subject, setSubject] = useState(defaultSubject);
  const [subjectDirty, setSubjectDirty] = useState(false);
  const [notes, setNotes] = useState(material?.notes ?? "");
  const [quantity, setQuantity] = useState("1");
  const [location, setLocation] = useState("");
  const [sourceType, setSourceType] = useState("existing");
  const [sourceLabel, setSourceLabel] = useState("");
  const [sourceReference, setSourceReference] = useState("");
  const [arrivalAt, setArrivalAt] = useState("");
  const [returnDueAt, setReturnDueAt] = useState("");
  const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  const [idempotencyKey] = useState(newKey);
  async function save(receiveNow = false) {
    setBusy(true); setError("");
    const [kind, id] = subject.split(":");
    const body = isLot ? {
      confirmedQuantity: Number(quantity), location, sourceType, sourceLabel, sourceReference,
      expectedArrivalAt: arrivalAt || undefined, returnDueAt: returnDueAt || undefined,
      returnDueQuantity: sourceType === "rented" || sourceType === "borrowed" ? Number(quantity) : undefined,
      receiveNow, idempotencyKey,
    } : { name, category, trackingStrategy: tracking, unit, quantityScale: Number(scale), notes,
      ...(mode === "create" || subjectDirty
        ? { departmentId: kind === "dept" ? id : null, groupId: kind === "group" ? id : null }
        : {}) };
    const url = isLot
      ? `/api/production/${productionId}/materials/${material?.id}/lots`
      : mode === "edit" ? `/api/production/${productionId}/materials/${material?.id}` : `/api/production/${productionId}/materials`;
    try {
      const response = await fetch(url, { method: mode === "edit" ? "PATCH" : "POST", headers: { "Content-Type": "application/json", ...(isLot ? { "Idempotency-Key": idempotencyKey } : {}) }, body: JSON.stringify(body) });
      const data = await response.json();
      if (!response.ok) { setError(errorMessage(data, "保存失败")); return; }
      await onSaved((data as { material?: MaterialListItem }).material?.id ?? material?.id,
        receiveNow ? (data as { identifiers?: MaterialIdentifier[] }).identifiers : undefined);
    } catch { setError("网络状态不确定，请检查列表后再重试；表单内容已保留。"); }
    finally { setBusy(false); }
  }
  const title = mode === "create" ? "新增物料类型" : mode === "edit" ? "编辑物料类型" : "确认实物或批次";
  return <div className={styles.modalBackdrop} role="presentation"><section className={styles.modal} role="dialog" aria-modal="true"><header><h2>{title}</h2><button className={styles.button} onClick={onClose}>关闭</button></header><div className={styles.form}>
    {isLot ? <>
      <div className={styles.notice}>{material?.trackingStrategy === "serialized" ? "逐件物料会为每一件生成独立编号。已经到货时可直接确认并入库，一次生成全部标签。" : "确认批次记录已经确定会到库的数量；已经到货时也可直接确认并入库。"}</div>
      <div className={styles.formGrid}><label className={styles.field}>确认数量<input type="number" min="0" step={10 ** -Number(scale)} value={quantity} onChange={e => setQuantity(e.target.value)} /></label><label className={styles.field}>登记库位<input value={location} onChange={e => setLocation(e.target.value)} /></label></div>
      <div className={styles.formGrid}><label className={styles.field}>来源<select value={sourceType} onChange={e => setSourceType(e.target.value)}>{Object.entries(sourceLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label><label className={styles.field}>来源名称<input value={sourceLabel} onChange={e => setSourceLabel(e.target.value)} placeholder="租赁或借用时必填" /></label></div>
      <label className={styles.field}>来源单号/参考<input value={sourceReference} onChange={e => setSourceReference(e.target.value)} /></label>
      <div className={styles.formGrid}><label className={styles.field}>预计到货<input type="datetime-local" value={arrivalAt} onChange={e => setArrivalAt(e.target.value)} /></label>{(sourceType === "rented" || sourceType === "borrowed") && <label className={styles.field}>应还时间<input type="datetime-local" value={returnDueAt} onChange={e => setReturnDueAt(e.target.value)} /></label>}</div>
    </> : <>
      <div className={styles.formGrid}><label className={styles.field}>名称<input autoFocus value={name} onChange={e => setName(e.target.value)} /></label><label className={styles.field}>分类<input value={category} onChange={e => setCategory(e.target.value)} /></label></div>
      <label className={styles.field}>责任方<select value={subject} onChange={e => { setSubject(e.target.value); setSubjectDirty(true); }}><option value="">请选择</option>{defaultSubject && !subjects.some(s => `${s.kind}:${s.id}` === defaultSubject) && <option value={defaultSubject}>{material?.departmentName ?? material?.groupName ?? "当前责任方"}</option>}{subjects.filter(s => s.poc || mode === "edit").map(s => <option key={`${s.kind}:${s.id}`} value={`${s.kind}:${s.id}`}>{s.name}</option>)}</select></label>
      <div className={styles.formGrid}><label className={styles.field}>跟踪方式<select value={tracking} onChange={e => setTracking(e.target.value as typeof tracking)} disabled={mode === "edit" && material!.heldQuantity + material!.expectedQuantity + material!.exitedQuantity > 0}>{Object.entries(trackingLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label className={styles.field}>单位<input value={unit} onChange={e => setUnit(e.target.value)} /></label></div>
      <label className={styles.field}>小数精度<select value={scale} onChange={e => setScale(Number(e.target.value))} disabled={tracking === "serialized"}>{[0, 1, 2, 3].map(x => <option key={x} value={x}>{x} 位</option>)}</select></label>
      <label className={styles.field}>备注<textarea rows={3} value={notes} onChange={e => setNotes(e.target.value)} /></label>
    </>}
    {error && <div className={styles.error}>{error}</div>}<div className={styles.formFooter}><button className={styles.button} onClick={onClose}>取消</button>{isLot && <button className={styles.button} disabled={busy || Number(quantity) <= 0} onClick={() => void save(false)}>{busy ? "处理中…" : "仅确认待到货"}</button>}<button className={styles.primary} disabled={busy || (!isLot && !name.trim()) || (isLot && Number(quantity) <= 0)} onClick={() => void save(isLot)}>{busy ? "处理中…" : isLot ? "确认并入库" : "保存"}</button></div>
  </div></section></div>;
}

function MovementDialog({ action, productionId, currentUserId, detail, capabilities, prefilledLotId, onClose, onSaved }: {
  action: Action; productionId: string; currentUserId: string; detail: MaterialDetailResponse;
  capabilities: MaterialCapabilitiesResponse; prefilledLotId: string | null; onClose(): void; onSaved(): void | Promise<void>;
}) {
  const lotAllowed = (lot: MaterialLotView) => {
    const cap = capabilities.byLot[lot.id];
    if (!cap) return false;
    if (action === "receipt" || action === "cancel") return cap.confirmReceipt && lot.expectedQuantity > 0;
    if (action === "checkout") return cap.checkoutSelf && lot.inStockQuantity > 0;
    if (action === "return") return (cap.returnOwn || cap.returnForOthers) && lot.checkedOutQuantity > 0;
    if (action === "damage") return (cap.reportDamageInCustody && lot.checkedOutQuantity > 0) || (cap.manageMaintenance && lot.inStockQuantity > 0);
    if (action === "repair") return cap.manageMaintenance && lot.maintenanceQuantity > 0;
    if (action === "source_return") return cap.returnToSource && lot.inStockQuantity > 0;
    if (action.startsWith("adjust")) return cap.adjustStock;
    return cap.exitStock && lot.inStockQuantity > 0;
  };
  const allowedLots = detail.lots.filter(lotAllowed);
  const [lotId, setLotId] = useState(prefilledLotId && allowedLots.some(x => x.id === prefilledLotId) ? prefilledLotId : allowedLots[0]?.id ?? "");
  const lot = detail.lots.find(x => x.id === lotId);
  const eligibleCheckouts = detail.checkouts.filter(c => c.lotId === lotId && c.outstandingQuantity > 0
    && (capabilities.byLot[lotId]?.returnForOthers || (c.custodian?.kind === "user" && c.custodian.id === currentUserId)));
  const [checkoutId, setCheckoutId] = useState(eligibleCheckouts[0]?.movementId ?? "");
  const [quantity, setQuantity] = useState("1"); const [reason, setReason] = useState("");
  const [custodianLabel, setCustodianLabel] = useState(""); const [error, setError] = useState("");
  const [toLocation, setToLocation] = useState("");
  const [checkoutSelf, setCheckoutSelf] = useState(true);
  const [busy, setBusy] = useState(false); const [idempotencyKey] = useState(newKey);
  const [adjustmentDirection, setAdjustmentDirection] = useState<"add" | "remove">(action === "adjust_remove" ? "remove" : "add");
  const [riskConfirmed, setRiskConfirmed] = useState(false);
  const highRisk = action === "exit" || action.startsWith("adjust");
  const titles: Record<Action, string> = { receipt: "登记入库", checkout: "登记签出", return: "登记返还", damage: "报损或送修", repair: "修复入库", exit: "退出库存", adjust_add: "盘点增加", adjust_remove: "盘点减少", source_return: "退还来源方", cancel: "取消待到货" };
  async function save() {
    if (!lot) return;
    let fromBucket = "in_stock", toBucket = "checked_out", returnOfMovementId: string | undefined;
    if (action === "receipt") { fromBucket = "expected"; toBucket = "in_stock"; }
    if (action === "cancel") { fromBucket = "expected"; toBucket = "cancelled"; }
    if (action === "return") { fromBucket = "checked_out"; toBucket = "in_stock"; returnOfMovementId = checkoutId; }
    if (action === "damage") { fromBucket = eligibleCheckouts.length ? "checked_out" : "in_stock"; toBucket = "maintenance"; returnOfMovementId = eligibleCheckouts.length ? checkoutId : undefined; }
    if (action === "repair") { fromBucket = "maintenance"; toBucket = "in_stock"; }
    if (action === "exit" || action === "source_return") { fromBucket = "in_stock"; toBucket = "exited"; }
    if (action.startsWith("adjust") && adjustmentDirection === "add") { fromBucket = "adjustment"; toBucket = "in_stock"; }
    if (action.startsWith("adjust") && adjustmentDirection === "remove") { fromBucket = "in_stock"; toBucket = "adjustment"; }
    const body: Record<string, unknown> = { lotId, quantity: Number(quantity), fromBucket, toBucket, returnOfMovementId,
      reason: reason.trim() || titles[action], note: reason.trim(),
      toLocation: toLocation.trim() || (toBucket === "in_stock" ? lot.location : undefined), idempotencyKey };
    if (action === "checkout") {
      body.custodian = checkoutSelf ? { kind: "user", id: currentUserId } : null;
      body.custodianLabel = checkoutSelf ? "本人" : custodianLabel;
    }
    if (action === "exit") body.exitReason = "scrapped";
    if (action === "source_return") body.exitReason = "returned_to_source";
    setBusy(true); setError("");
    try {
      const response = await fetch(`/api/production/${productionId}/materials/${detail.material.id}/movements`, { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey }, body: JSON.stringify(body) });
      const data = await response.json();
      if (!response.ok) { setError(errorMessage(data, "登记失败")); return; }
      await onSaved();
    } catch { setError("网络状态不确定。请勿新建另一笔操作，恢复网络后可用当前表单安全重试。"); }
    finally { setBusy(false); }
  }
  return <div className={styles.modalBackdrop}><section className={styles.modal} role="dialog" aria-modal="true"><header><h2>{titles[action]}</h2><button className={styles.button} onClick={onClose}>关闭</button></header><div className={styles.form}>
    {detail.material.trackingStrategy === "serialized" && prefilledLotId
      ? <div className={styles.notice}>当前编号：{detail.identifiers.find(x => x.lotId === lotId && x.kind === "internal_code")?.displayValue ?? lotId} · {bucketLabels[lot?.currentBucket ?? ""] ?? "多状态"}</div>
      : <label className={styles.field}>实物或批次<select value={lotId} onChange={e => { setLotId(e.target.value); setCheckoutId(""); }}>{allowedLots.map(l => <option key={l.id} value={l.id}>{detail.identifiers.find(x => x.lotId === l.id && x.kind === "internal_code")?.displayValue ?? l.id} · {bucketLabels[l.currentBucket ?? ""] ?? "多状态"}</option>)}</select></label>}
    {(action === "return" || (action === "damage" && eligibleCheckouts.length > 0)) && <label className={styles.field}>原签出<select value={checkoutId} onChange={e => setCheckoutId(e.target.value)}>{eligibleCheckouts.map(c => <option key={c.movementId} value={c.movementId}>{new Date(c.createdAt).toLocaleString("zh-CN")} · 尚欠 {c.outstandingQuantity}{detail.material.unit} · {c.custodianLabel || "未标注"}</option>)}</select></label>}
    <div className={styles.formGrid}><label className={styles.field}>数量<input type="number" min="0" step={10 ** -detail.material.quantityScale} value={quantity} disabled={detail.material.trackingStrategy === "serialized"} onChange={e => setQuantity(e.target.value)} /></label>{action === "checkout" && <label className={styles.field}>登记方式<select value={checkoutSelf ? "self" : "other"} onChange={e => setCheckoutSelf(e.target.value === "self")}><option value="self">本人签出</option><option value="other" disabled={!capabilities.byLot[lotId]?.checkoutForOthers}>代他人或外部经手</option></select></label>}</div>
    {action === "checkout" && !checkoutSelf && <label className={styles.field}>经手对象或去向<input value={custodianLabel} onChange={e => setCustodianLabel(e.target.value)} placeholder="姓名、团队或外部去向" /></label>}
    <label className={styles.field}>目标库位或去向<input value={toLocation} onChange={e => setToLocation(e.target.value)} placeholder={lot?.location || "选填"} /></label>
    <label className={styles.field}>原因或备注<textarea rows={3} value={reason} onChange={e => setReason(e.target.value)} /></label>
    {(action === "adjust_add" || action === "adjust_remove") && <label className={styles.field}>调整方向<select value={adjustmentDirection} onChange={e => setAdjustmentDirection(e.target.value as "add" | "remove")}><option value="add">盘盈（增加在库）</option><option value="remove">盘亏（减少在库）</option></select></label>}
    {highRisk && <label className={styles.notice}><input type="checkbox" checked={riskConfirmed} onChange={e => setRiskConfirmed(e.target.checked)} /> 我已核对实物、数量和原因；这会追加正式库存事实。</label>}
    {error && <div className={styles.error}>{error}</div>}<div className={styles.formFooter}><button className={styles.button} onClick={onClose}>取消</button><button className={styles.primary} disabled={busy || !lotId || Number(quantity) <= 0 || (action === "checkout" && !checkoutSelf && !custodianLabel.trim()) || (highRisk && (!riskConfirmed || !reason.trim())) || ((action === "return" || (action === "damage" && Boolean(lot?.checkedOutQuantity))) && !checkoutId)} onClick={() => void save()}>{busy ? "登记中…" : "确认登记"}</button></div>
  </div></section></div>;
}
