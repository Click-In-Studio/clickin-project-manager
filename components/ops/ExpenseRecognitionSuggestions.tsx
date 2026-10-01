"use client";

import { useEffect, useRef, useState } from "react";
import { BASE_PATH } from "@/lib/base-path";
import type {
  ExpenseDocumentRecognition,
} from "@/lib/ops/expense-recognition-types";
import { buildExpenseRecognitionCandidates } from "@/lib/ops/expense-recognition-candidates";
import { formatCurrencyLabel, isCurrencyCode } from "@/lib/money";
import styles from "./expense-recognition-suggestions.module.css";

export type RecognizableExpenseDocument = {
  assetId: string;
  assetFileId: string;
  fileName: string;
  recognition: ExpenseDocumentRecognition | null;
};

const STATUS_TEXT: Record<ExpenseDocumentRecognition["status"], string> = {
  queued: "等待识别",
  processing: "正在识别",
  succeeded: "已识别",
  failed: "未能识别，可手动填写",
  unavailable: "识别服务暂不可用，可手动填写",
};
const CONFIDENCE_TEXT = { high: "高", medium: "中", low: "低" } as const;
const SOURCE_TEXT = { pdf_text: "PDF 文本层", ocr: "MMP OCR", pdf_text_ocr: "PDF 文本层 + MMP OCR" } as const;

function displayCurrency(value: string | null | undefined): string {
  return isCurrencyCode(value) ? formatCurrencyLabel(value) : value ?? "币种未知";
}

export function recognitionStatusText(recognition: ExpenseDocumentRecognition | null): string {
  return recognition ? STATUS_TEXT[recognition.status] : "等待识别";
}

export function ExpenseRecognitionSuggestions({
  productionId,
  baseCurrency,
  documents,
  current,
  onRecognition,
  onRetry,
}: {
  productionId: string;
  baseCurrency: string;
  documents: RecognizableExpenseDocument[];
  current: { amount: string; merchant: string; occurredOn: string };
  onRecognition: (assetFileId: string, recognition: ExpenseDocumentRecognition | null) => void;
  onRetry?: (assetId: string) => void;
}) {
  const [expanded, setExpanded] = useState(true);
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
  const aggregate = buildExpenseRecognitionCandidates(documents);

  if (documents.length === 0) return null;
  const noticeDocument = documents.find(document => document.assetFileId === noticeFileId);
  const noticeResult = noticeDocument?.recognition?.result;
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
                  </span>
                  {result.merchant.value && <span title={result.merchant.evidence ?? undefined}>商户：{result.merchant.value} · 置信度{CONFIDENCE_TEXT[result.merchant.confidence]}</span>}
                  {result.occurredOn.value && <span title={result.occurredOn.evidence ?? undefined}>日期：{result.occurredOn.value} · 置信度{CONFIDENCE_TEXT[result.occurredOn.confidence]}</span>}
                  {result.documentNumber.value && <span title={result.documentNumber.evidence ?? undefined}>号码：{result.documentNumber.value} · 置信度{CONFIDENCE_TEXT[result.documentNumber.confidence]}</span>}
                  {result.totalAmount.value && <span title={result.totalAmount.evidence ?? undefined}>含税金额：{displayCurrency(result.currency.value)} {result.totalAmount.value} · 置信度{CONFIDENCE_TEXT[result.totalAmount.confidence]}</span>}
                  {result.taxAmount.value && <span title={result.taxAmount.evidence ?? undefined}>税额：{result.taxAmount.value} · 置信度{CONFIDENCE_TEXT[result.taxAmount.confidence]}</span>}
                  {[result.merchant, result.occurredOn, result.totalAmount].some(field => field.confidence === "low")
                    && <small>部分字段置信度较低，请对照原件</small>}
                  {result.warnings.map((warning, index) => <small key={`${warning}-${index}`}>{warning}</small>)}
                </div>
              ))}
              {aggregate.mixedTypes && <p className={styles.warning}>发票与收据可能对应同一笔消费，未自动合计金额。</p>}
              {aggregate.mixedTypes && aggregate.totalsByType.map(total => (
                <p key={total.type} className={styles.groupTotal}>
                  {total.type === "invoice" ? "发票" : total.type === "receipt" ? "收据" : "其他凭证"}候选合计：{displayCurrency(aggregate.currencies[0])} {total.amount}
                </p>
              ))}
              {aggregate.currencies.length > 1 && <p className={styles.warning}>凭证币种不一致，未自动合计金额。</p>}
              {aggregate.merchantConflict && <p className={styles.warning}>多份凭证的商户不一致，请逐份核对。</p>}
              {aggregate.dateConflict && <p className={styles.warning}>多份凭证的日期不一致，请逐份核对。</p>}
              {current.amount && aggregate.amount && current.amount !== aggregate.amount && (
                <p className={styles.warning}>票面合计 {displayCurrency(aggregate.currencies[0])} {aggregate.amount} 与当前报销金额 {current.amount} 不一致。</p>
              )}
              {aggregate.currencies.some(currency => currency !== baseCurrency) && (
                <p className={styles.warning}>识别到非本位币，请人工确认汇率、日期、来源和折算结果。</p>
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
            识别完成{noticeResult.totalAmount.value ? `：${displayCurrency(noticeResult.currency.value)} ${noticeResult.totalAmount.value}` : ""}
            {noticeResult.merchant.value ? ` · ${noticeResult.merchant.value}` : ""}
          </span>
          <button type="button" onClick={() => {
            setExpanded(true);
            setNoticeFileId(null);
          }}>查看识别结果</button>
          <button type="button" className={styles.dismiss} aria-label="不使用识别建议"
            onClick={() => setNoticeFileId(null)}>×</button>
        </div>
      )}
    </>
  );
}
