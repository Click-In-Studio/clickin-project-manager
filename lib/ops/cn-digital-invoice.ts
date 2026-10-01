import type { PdfDoc, PdfLine } from "@/lib/doc-extract/pdf";
import type { ExpenseRecognitionResult, RecognitionCandidate } from "./expense-recognition-types";

export const CN_DIGITAL_INVOICE_RULES_VERSION = "cn-digital-invoice-v1";

const LARGE_GAP = /⟨\d+⟩/g;
const EXCLUDED_DOCUMENT = /汇总单|行程单|运单明细/;
const INVOICE_TITLE = /电子发票\((?:增值税专用发票|普通发票)\)/;

function compact(value: string): string {
  return value.normalize("NFKC").replace(LARGE_GAP, "").replace(/\s+/g, "");
}

function high(value: string, evidence: string): RecognitionCandidate {
  return { value, confidence: "high", evidence: evidence.trim().slice(0, 300) };
}

function amount(value: string): string | null {
  const normalized = value.replace(/[,，]/g, "");
  if (!/^\d{1,12}(?:\.\d{1,2})?$/.test(normalized)) return null;
  return normalized.includes(".") ? normalized : `${normalized}.00`;
}

function toCents(value: string): number {
  const [whole, fraction = ""] = value.split(".");
  return Number(whole) * 100 + Number((fraction + "00").slice(0, 2));
}

function validDate(year: string, month: string, day: string): string | null {
  const value = `${year}-${month}-${day}`;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value ? value : null;
}

function findLine(lines: PdfLine[], pattern: RegExp): { line: PdfLine; match: RegExpMatchArray } | null {
  for (const line of lines) {
    const match = compact(line.text).match(pattern);
    if (match) return { line, match };
  }
  return null;
}

function invoiceDate(lines: PdfLine[]): { value: string; evidence: string } | null {
  const label = lines.find(line => compact(line.text).includes("开票日期"));
  if (!label) return null;
  const nearby = lines.filter(line => line === label || Math.abs(line.y - label.y) <= 16);
  const candidates = nearby.flatMap(line => {
    const match = compact(line.text).match(/(\d{4})年(\d{2})月(\d{2})日/);
    const value = match ? validDate(match[1], match[2], match[3]) : null;
    return value ? [{ value, line }] : [];
  });
  const unique = [...new Set(candidates.map(candidate => candidate.value))];
  if (unique.length !== 1) return null;
  const chosen = candidates.find(candidate => candidate.value === unique[0])!;
  return { value: chosen.value, evidence: [label.text, chosen.line.text].join(" ") };
}

function invoiceNumber(lines: PdfLine[], date: string): { value: string; evidence: string } | null {
  const label = lines.find(line => compact(line.text).includes("发票号码"));
  if (!label) return null;
  const nearby = lines.filter(line => line === label || Math.abs(line.y - label.y) <= 16);
  const candidates = nearby.flatMap(line => [...compact(line.text).matchAll(/(?<!\d)(\d{20})(?!\d)/g)]
    .map(match => ({ value: match[1], line })))
    .filter(candidate => candidate.value.slice(0, 2) === date.slice(2, 4));
  const unique = [...new Set(candidates.map(candidate => candidate.value))];
  if (unique.length !== 1) return null;
  const chosen = candidates.find(candidate => candidate.value === unique[0])!;
  return { value: chosen.value, evidence: [label.text, chosen.line.text].join(" ") };
}

function grossAmount(lines: PdfLine[]): { value: string; evidence: string } | null {
  const label = lines.find(line => compact(line.text).includes("价税合计"));
  if (!label) return null;
  const inline = compact(label.text).match(/\(小写\)[¥￥]?([\d,]+(?:\.\d{1,2})?)/);
  if (inline) {
    const value = amount(inline[1]);
    return value ? { value, evidence: label.text } : null;
  }
  const nearby = lines.filter(line => line !== label && Math.abs(line.y - label.y) <= 12)
    .flatMap(line => [...compact(line.text).matchAll(/(?:[¥￥]|(?<![\d.]))([\d,]+\.\d{2})(?![\d.])/g)]
      .map(match => ({ raw: match[1], line })));
  if (nearby.length !== 1) return null;
  const value = amount(nearby[0].raw);
  return value ? { value, evidence: [label.text, nearby[0].line.text].join(" ") } : null;
}

function totalAmounts(lines: PdfLine[]): { values: string[]; evidence: string } | null {
  const label = lines.find(line => {
    const text = compact(line.text);
    return text.includes("合计") && !text.includes("价税合计");
  });
  if (!label) return null;
  const nearby = lines.filter(line => line === label || Math.abs(line.y - label.y) <= 10);
  const values = nearby.flatMap(line => [...compact(line.text).matchAll(/[¥￥]([\d,]+(?:\.\d{1,2})?)/g)]
    .map(match => amount(match[1])).filter((value): value is string => value !== null));
  if (values.length < 1 || values.length > 2) return null;
  return { values, evidence: nearby.map(line => line.text).join(" ") };
}

function nameValues(line: PdfLine): string[] {
  const text = compact(line.text);
  const markers: number[] = [];
  let from = 0;
  while (from < text.length) {
    const index = text.indexOf("名称:", from);
    if (index < 0) break;
    if (text.slice(Math.max(0, index - 2), index) !== "项目") markers.push(index);
    from = index + 3;
  }
  return markers.map((index, position) => {
    const start = index + 3;
    const end = markers[position + 1] ?? text.length;
    return text.slice(start, end)
      .replace(/^(?:购|买|方|销|售|信|息)+/, "")
      .replace(/(?:购|买|方|销|售|信|息)+$/, "")
      .trim();
  });
}

function seller(lines: PdfLine[], pageWidth: number): { value: string; evidence: string } | null {
  for (const line of lines) {
    const values = nameValues(line);
    const sellerValue = values.length >= 2 ? values[values.length - 1] : null;
    if (sellerValue && sellerValue !== values[0]) {
      return { value: sellerValue, evidence: line.text };
    }
  }

  const candidates = lines.flatMap(line => nameValues(line)
    .filter(Boolean).map(value => ({ value, line })));
  const rightSide = candidates.filter(candidate => candidate.line.x >= pageWidth / 2);
  const chosen = rightSide[0] ?? (candidates.length >= 2 ? candidates[candidates.length - 1] : null);
  return chosen ? { value: chosen.value, evidence: chosen.line.text } : null;
}

/**
 * 只接受一页、原生文本层完整且能通过强校验的标准中国数电发票。
 * 任一条件不满足都返回 null，让调用方无损回退 LLM。
 */
export function parseCnDigitalInvoice(doc: PdfDoc): ExpenseRecognitionResult | null {
  if (doc.pages.length !== 1 || doc.pages[0].status !== "ok") return null;
  const page = doc.pages[0];
  const lines = page.lines.filter(line => line.text.trim());
  const all = compact(lines.map(line => line.text).join("\n"));
  if (EXCLUDED_DOCUMENT.test(all) || !INVOICE_TITLE.test(all)) return null;

  const title = findLine(lines, INVOICE_TITLE);
  const issued = invoiceDate(lines);
  const number = issued ? invoiceNumber(lines, issued.value) : null;
  const gross = grossAmount(lines);
  const totals = totalAmounts(lines);
  const merchant = seller(lines, page.width);
  if (!title || !number || !issued || !gross || !totals || !merchant) return null;

  const date = issued.value;
  const totalAmount = gross.value;

  const totalParts = totals.values;
  if (totalParts.length < 1 || totalParts.length > 2) return null;
  const netCents = toCents(totalParts[0]);
  const taxCents = totalParts[1] ? toCents(totalParts[1]) : 0;
  if (netCents + taxCents !== toCents(totalAmount)) return null;

  return {
    documentType: high("invoice", title.line.text),
    merchant: high(merchant.value, merchant.evidence),
    occurredOn: high(date, issued.evidence),
    documentNumber: high(number.value, number.evidence),
    totalAmount: high(totalAmount, gross.evidence),
    taxAmount: totalParts[1]
      ? high(totalParts[1], totals.evidence)
      : { value: null, confidence: "low", evidence: totals.evidence.trim().slice(0, 300) },
    currency: high("CNY", gross.evidence),
    warnings: [],
  };
}
