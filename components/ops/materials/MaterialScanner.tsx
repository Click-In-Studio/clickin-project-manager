"use client";

import { useEffect, useRef, useState } from "react";
import styles from "./materials.module.css";

export type MaterialScanResolution = {
  status: "valid" | "inactive" | "unavailable";
  identifier: { materialId: string; lotId: string | null; displayValue: string };
  materialNumber: string; internalCode: string | null; materialName: string;
  currentBucket: string | null;
};
export type MaterialScanEntry = { code: string; result: MaterialScanResolution };

export default function MaterialScanner({ productionId, initialEntries, onEntriesChange, onResolved, onUnknown, onClose }: {
  productionId: string;
  initialEntries: MaterialScanEntry[];
  onEntriesChange: (entries: MaterialScanEntry[]) => void;
  onResolved: (result: MaterialScanResolution) => void;
  onUnknown?: (code: string) => void;
  onClose: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const controlsRef = useRef<{ stop(): void } | null>(null);
  const seenRef = useRef(new Set(initialEntries.map(entry => entry.code)));
  const [manual, setManual] = useState("");
  const [cameraError, setCameraError] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [entries, setEntries] = useState(initialEntries);
  const [unknownCodes, setUnknownCodes] = useState<string[]>([]);

  async function resolve(code: string) {
    const normalized = code.trim();
    if (!normalized || seenRef.current.has(normalized)) return;
    seenRef.current.add(normalized);
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/production/${productionId}/material-identifiers/resolve`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: normalized, action: "view" }),
      });
      const data = await response.json() as MaterialScanResolution & { error?: string };
      if (!response.ok) {
        setError(data.error ?? "无法识别这个码");
        if (response.status === 404) setUnknownCodes(current => [...current, normalized]);
        else seenRef.current.delete(normalized);
        return;
      }
      setEntries(current => {
        const next = [...current, { code: normalized, result: data }];
        onEntriesChange(next);
        return next;
      });
      setManual("");
    } catch {
      setError("网络状态不确定，未执行任何库存动作。请恢复网络后重试。");
      seenRef.current.delete(normalized);
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    let disposed = false;
    void import("@zxing/browser").then(async ({ BrowserMultiFormatReader }) => {
      if (disposed || !videoRef.current) return;
      try {
        const reader = new BrowserMultiFormatReader();
        controlsRef.current = await reader.decodeFromConstraints(
          { video: { facingMode: { ideal: "environment" } }, audio: false },
          videoRef.current,
          (result) => { if (result) void resolve(result.getText()); },
        );
      } catch {
        setCameraError("无法打开摄像头，可以在下方手动输入或粘贴编号。");
      }
    });
    return () => { disposed = true; controlsRef.current?.stop(); };
    // 扫描器只在打开时建立一次；resolve 使用稳定的 productionId。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [productionId]);

  return (
    <div className={styles.modalBackdrop} role="presentation" onMouseDown={e => {
      if (e.target === e.currentTarget) onClose();
    }}>
      <section className={styles.modal} role="dialog" aria-modal="true" aria-labelledby="scanner-title">
        <header><h2 id="scanner-title">扫描物料码</h2><button className={styles.button} onClick={onClose}>关闭</button></header>
        <div className={`${styles.form} ${styles.scanner}`}>
          <video ref={videoRef} className={styles.video} muted playsInline />
          {cameraError && <div className={styles.notice}>{cameraError}</div>}
          <label className={styles.field}>手动输入
            <input value={manual} onChange={e => setManual(e.target.value)} placeholder="内部编号、条码或序列号"
              onKeyDown={e => { if (e.key === "Enter") void resolve(manual); }} />
          </label>
          {error && <div className={styles.error}>{error}</div>}
          {entries.length > 0 && <div className={styles.section}><h3>本次扫描 · {entries.length}</h3>{entries.map(({ result }, index) => <div className={styles.scanResult} key={`${result.identifier.displayValue}-${index}`}>
            <b>{result.materialNumber} · {result.materialName}</b><br />
            <span className={styles.muted}>{result.internalCode ?? result.identifier.displayValue} · {result.currentBucket ? `当前${result.currentBucket}` : "仅登记物料类型"}</span>
            <div className={styles.formFooter}><button className={styles.primary} disabled={!result.identifier.lotId || result.status !== "valid"} onClick={() => onResolved(result)}>选择并继续</button></div>
          </div>)}</div>}
          {unknownCodes.map(code => <div className={styles.scanResult} key={code}><b>未绑定：{code}</b><div className={styles.formFooter}><button className={styles.button} disabled={!onUnknown} title={onUnknown ? "绑定到当前打开的实物" : "请先打开一个有标识维护权限的物料"} onClick={() => onUnknown?.(code)}>绑定到当前实物</button></div></div>)}
          <div className={styles.formFooter}>
            <button className={styles.primary} disabled={busy || !manual.trim()} onClick={() => void resolve(manual)}>
              {busy ? "识别中…" : "识别并预填"}
            </button>
          </div>
          <div className={styles.notice}>扫描只定位物料和实物，不会直接改变库存。可连续扫描多件；同一码在本次会话只记一次，选择其中一件后再确认动作。</div>
        </div>
      </section>
    </div>
  );
}
