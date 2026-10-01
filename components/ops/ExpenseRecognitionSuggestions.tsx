"use client";

import { useEffect, useRef, useState } from "react";
import { BASE_PATH } from "@/lib/base-path";
import type {
  ExpenseDocumentRecognition, ExpenseRecognitionResult,
} from "@/lib/ops/expense-recognition-types";
import styles from "./expense-recognition-suggestions.module.css";

export type RecognizableExpenseDocument = {
  assetId: string;
  assetFileId: string;
  fileName: string;
  recognition: ExpenseDocumentRecognition | null;
};

type ApplyField = "amount" | "merchant" | "occurredOn";

const STATUS_TEXT: Record<ExpenseDocumentRecognition["status"], string> = {
  queued: "等待识别",
  processing: "正在识别",
  succeeded: "已识别",
  failed: "未能识别，可手动填写",
  unavailable: "识别服务暂不可用，可手动填写",
};
const CONFIDENCE_TEXT = { high: "高", medium: "中", low: "低" } as const;
const SOURCE_TEXT = { pdf_text: "PDF 文本层", ocr: "MMP OCR", pdf_text_ocr: "PDF 文本层 + MMP OCR" } as const;

export function recognitionStatusText(recognition: ExpenseDocumentRecognition | null): string {
  return recognition ? STATUS_TEXT[recognition.status] : "等待识别";
}

function cents(value: string): number | null {
  if (!/^\d{1,12}(\.\d{1,2})?$/.test(value)) return null;
  const [whole, fraction = ""] = value.split(".");
  return Number(whole) * 100 + Number((fraction + "00").slice(0, 2));
}

function amountFromCents(value: number): string {
  return `${Math.floor(value / 100)}.${String(value % 100).padStart(2, "0")}`;
}

function uniqueValues(results: ExpenseRecognitionResult[], field: "merchant" | "occurredOn" | "currency") {
  return [...new Set(results.map(result => result[field].value).filter((value): value is string => !!value))];
}

export function ExpenseRecognitionSuggestions({
  productionId,
  documents,
  current,
  onRecognition,
  onApply,
  onDocumentType,
  onRetry,
}: {
  productionId: string;
  documents: RecognizableExpenseDocument[];
  current: { amount: string; merchant: string; occurredOn: string };
  onRecognition: (assetFileId: string, recognition: ExpenseDocumentRecognition | null) => void;
  onApply?: (field: ApplyField, value: string) => void;
  onDocumentType?: (assetFileId: string, value: "invoice" | "receipt" | "other") => void;
  onRetry?: (assetId: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [noticeFileId, setNoticeFileId] = useState<string | null>(null);
  const seenSucceeded = useRef(new Set<string>());
  const documentsRef = useRef(documents);
  documentsRef.current = documents;
  const activeIds = documents
    .filter(document => !document.recognition
      || document.recognition.status === "queued"
      || document.recognition.status === "processing")
    .map(document => document.assetFileId)
    .join(",");

  useEffect(() => {
    if (!activeIds) return;
    let cancelled = false;
    const poll = async () => {
      const ids = new Set(activeIds.split(","));
      const active = documentsRef.current.filter(document => ids.has(document.assetFileId));
      await Promise.all(active.map(async document => {
        const response = await fetch(
          `${BASE_PATH}/api/production/${productionId}/finance/expense-documents/${document.assetId}/recognition`,
        ).catch(() => null);
        if (!response?.ok || cancelled) return;
        const data = await response.json() as { recognition: ExpenseDocumentRecognition | null };
        onRecognition(document.assetFileId, data.recognition);
        if (data.recognition?.status === "succeeded" && !seenSucceeded.current.has(document.assetFileId)) {
          seenSucceeded.current.add(document.assetFileId);
          setNoticeFileId(document.assetFileId);
        }
      }));
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 2000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [activeIds, onRecognition, productionId]);

  const successful = documents.filter(document => document.recognition?.status === "succeeded"
    && document.recognition.result).map(document => ({
      document,
      result: document.recognition!.result!,
    }));
  const aggregate = (() => {
    const results = successful.map(item => item.result);
    const currencies = uniqueValues(results, "currency");
    const merchants = uniqueValues(results, "merchant");
    const dates = uniqueValues(results, "occurredOn");
    const types = new Set(results.map(result => result.documentType.value).filter(Boolean));
    const totals = results.map(result => result.totalAmount.value).filter((value): value is string => !!value);
    const totalCents = totals.map(cents);
    const canTotal = totals.length === results.length && totalCents.every((value): value is number => value !== null)
      && currencies.length === 1 && currencies[0] === "CNY" && types.size <= 1;
    const totalsByType = [...types].map(type => {
      const values = successful.filter(item => item.result.documentType.value === type
        && item.result.currency.value === "CNY")
        .map(item => item.result.totalAmount.value).filter((value): value is string => !!value)
        .map(cents).filter((value): value is number => value !== null);
      return values.length ? {
        type,
        amount: amountFromCents(values.reduce((sum, value) => sum + value, 0)),
      } : null;
    }).filter((value): value is { type: string; amount: string } => value !== null);
    return {
      amount: canTotal ? amountFromCents(totalCents.reduce((sum, value) => sum + value, 0)) : null,
      merchant: merchants.length === 1 ? merchants[0] : null,
      occurredOn: dates.length === 1 ? dates[0] : null,
      currencies,
      mixedTypes: types.size > 1,
      merchantConflict: merchants.length > 1,
      dateConflict: dates.length > 1,
      totalsByType,
    };
  })();

  if (documents.length === 0) return null;
  const noticeDocument = documents.find(document => document.assetFileId === noticeFileId);
  const noticeResult = noticeDocument?.recognition?.result;
  const hasConflict = !!noticeResult && (
    documents.length > 1
    || (!!noticeResult.currency.value && noticeResult.currency.value !== "CNY")
    || (!!current.amount && !!noticeResult.totalAmount.value && current.amount !== noticeResult.totalAmount.value)
    || (!!current.merchant && !!noticeResult.merchant.value && current.merchant !== noticeResult.merchant.value)
    || (!!current.occurredOn && !!noticeResult.occurredOn.value && current.occurredOn !== noticeResult.occurredOn.value)
  );

  return (
    <>
      {successful.length > 0 && (
        <div className={styles.summary}>
          <button type="button" className={styles.summaryToggle} onClick={() => setExpanded(value => !value)}>
            {successful.length} 份凭证已有识别建议 · {expanded ? "收起" : "查看"}
          </button>
          {expanded && (
            <div className={styles.panel}>
              {successful.map(({ document, result }) => (
                <div key={document.assetFileId} className={styles.documentResult}>
                  <b>{document.fileName}</b>
                  <small>来源：{document.recognition?.sourceKind ? SOURCE_TEXT[document.recognition.sourceKind] : "未知"}</small>
                  {document.recognition?.outdated && (
                    <small>识别器已有更新{onRetry && <button type="button" onClick={() => onRetry(document.assetId)}>重新识别</button>}</small>
                  )}
                  <span>
                    {result.documentType.value === "invoice" ? "发票" : result.documentType.value === "receipt" ? "收据" : "其他凭证"}
                    {onDocumentType && <button type="button" onClick={() => onDocumentType(
                      document.assetFileId,
                      result.documentType.value as "invoice" | "receipt" | "other",
                    )}>采用类型</button>}
                  </span>
                  {result.merchant.value && <span title={result.merchant.evidence ?? undefined}>商户：{result.merchant.value} · 置信度{CONFIDENCE_TEXT[result.merchant.confidence]}</span>}
                  {result.occurredOn.value && <span title={result.occurredOn.evidence ?? undefined}>日期：{result.occurredOn.value} · 置信度{CONFIDENCE_TEXT[result.occurredOn.confidence]}</span>}
                  {result.documentNumber.value && <span title={result.documentNumber.evidence ?? undefined}>号码：{result.documentNumber.value} · 置信度{CONFIDENCE_TEXT[result.documentNumber.confidence]}</span>}
                  {result.totalAmount.value && <span title={result.totalAmount.evidence ?? undefined}>含税金额：{result.currency.value ?? "币种未知"} {result.totalAmount.value} · 置信度{CONFIDENCE_TEXT[result.totalAmount.confidence]}</span>}
                  {result.taxAmount.value && <span title={result.taxAmount.evidence ?? undefined}>税额：{result.taxAmount.value} · 置信度{CONFIDENCE_TEXT[result.taxAmount.confidence]}</span>}
                  {[result.merchant, result.occurredOn, result.totalAmount].some(field => field.confidence === "low")
                    && <small>部分字段置信度较低，请对照原件</small>}
                  {result.warnings.map((warning, index) => <small key={`${warning}-${index}`}>{warning}</small>)}
                </div>
              ))}
              {aggregate.mixedTypes && <p className={styles.warning}>发票与收据可能对应同一笔消费，未自动合计金额。</p>}
              {aggregate.mixedTypes && aggregate.totalsByType.map(total => (
                <p key={total.type} className={styles.groupTotal}>
                  {total.type === "invoice" ? "发票" : total.type === "receipt" ? "收据" : "其他凭证"}候选合计：¥{total.amount}
                </p>
              ))}
              {aggregate.currencies.length > 1 && <p className={styles.warning}>凭证币种不一致，未自动合计金额。</p>}
              {aggregate.merchantConflict && <p className={styles.warning}>多份凭证的商户不一致，请逐份核对。</p>}
              {aggregate.dateConflict && <p className={styles.warning}>多份凭证的日期不一致，请逐份核对。</p>}
              {current.amount && aggregate.amount && current.amount !== aggregate.amount && (
                <p className={styles.warning}>票面合计 ¥{aggregate.amount} 与当前报销金额 ¥{current.amount} 不一致。</p>
              )}
              {aggregate.currencies.some(currency => currency !== "CNY") && (
                <p className={styles.warning}>非 CNY 凭证暂不支持自动写入金额，也不会换算汇率。</p>
              )}
              {onApply && (
                <div className={styles.applyRows}>
                  {aggregate.merchant && <span>商户：{aggregate.merchant}<button type="button" onClick={() => onApply("merchant", aggregate.merchant!)}>采用</button></span>}
                  {aggregate.occurredOn && <span>发生日期：{aggregate.occurredOn}<button type="button" onClick={() => onApply("occurredOn", aggregate.occurredOn!)}>采用</button></span>}
                  {aggregate.amount && <span>凭证合计：¥{aggregate.amount}<button type="button" onClick={() => onApply("amount", aggregate.amount!)}>采用</button></span>}
                </div>
              )}
            </div>
          )}
        </div>
      )}
      {documents.some(document => document.recognition?.status === "failed"
        || document.recognition?.status === "unavailable") && (
        <div className={styles.failures}>
          {documents.filter(document => document.recognition?.status === "failed"
            || document.recognition?.status === "unavailable").map(document => (
            <span key={document.assetFileId}>
              {document.fileName}：{recognitionStatusText(document.recognition)}
              {onRetry && <button type="button" onClick={() => onRetry(document.assetId)}>重试</button>}
            </span>
          ))}
        </div>
      )}
      {noticeResult && (
        <div className={styles.notice} role="status" aria-live="polite">
          <span>
            识别完成{noticeResult.totalAmount.value ? `：${noticeResult.currency.value ?? ""} ${noticeResult.totalAmount.value}` : ""}
            {noticeResult.merchant.value ? ` · ${noticeResult.merchant.value}` : ""}
          </span>
          <button type="button" onClick={() => {
            if (!hasConflict && onApply) {
              if (noticeResult.merchant.value) onApply("merchant", noticeResult.merchant.value);
              if (noticeResult.occurredOn.value) onApply("occurredOn", noticeResult.occurredOn.value);
              if (noticeResult.currency.value === "CNY" && noticeResult.totalAmount.value)
                onApply("amount", noticeResult.totalAmount.value);
              if (noticeDocument && onDocumentType)
                onDocumentType(noticeDocument.assetFileId, noticeResult.documentType.value as "invoice" | "receipt" | "other");
            } else {
              setExpanded(true);
            }
            setNoticeFileId(null);
          }}>{hasConflict ? "查看建议" : "填入"}</button>
          <button type="button" className={styles.dismiss} aria-label="不使用识别建议"
            onClick={() => setNoticeFileId(null)}>×</button>
        </div>
      )}
    </>
  );
}
