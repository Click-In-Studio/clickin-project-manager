import type { ExpenseDocumentRecognition, ExpenseRecognitionResult } from "./expense-recognition-types";

export type ExpenseRecognitionCandidateDocument = {
  recognition: ExpenseDocumentRecognition | null;
};

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

export function buildExpenseRecognitionCandidates(documents: ExpenseRecognitionCandidateDocument[]) {
  const results = documents
    .filter(document => document.recognition?.status === "succeeded" && document.recognition.result)
    .map(document => document.recognition!.result!);
  const currencies = uniqueValues(results, "currency");
  const merchants = uniqueValues(results, "merchant");
  const dates = uniqueValues(results, "occurredOn");
  const types = new Set(results.map(result => result.documentType.value).filter(Boolean));
  const totals = results.map(result => result.totalAmount.value).filter((value): value is string => !!value);
  const totalCents = totals.map(cents);
  const canTotal = totals.length === results.length && totalCents.every((value): value is number => value !== null)
    && currencies.length === 1 && currencies[0] === "CNY" && types.size <= 1;
  const totalsByType = [...types].map(type => {
    const values = results.filter(result => result.documentType.value === type && result.currency.value === "CNY")
      .map(result => result.totalAmount.value).filter((value): value is string => !!value)
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
}
