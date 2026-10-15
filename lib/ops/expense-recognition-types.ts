export type RecognitionConfidence = "high" | "medium" | "low";
export type RecognizedDocumentType = "invoice" | "receipt" | "other";
export type RecognitionStatus = "queued" | "processing" | "succeeded" | "failed" | "unavailable";
export type RecognitionSourceKind = "pdf_text" | "ocr" | "pdf_text_ocr";

export type RecognitionCandidate = {
  value: string | null;
  confidence: RecognitionConfidence;
  evidence: string | null;
};

export type ExpenseRecognitionResult = {
  documentType: RecognitionCandidate;
  merchant: RecognitionCandidate;
  occurredOn: RecognitionCandidate;
  documentNumber: RecognitionCandidate;
  totalAmount: RecognitionCandidate;
  taxAmount: RecognitionCandidate;
  currency: RecognitionCandidate;
  warnings: string[];
};

export type ExpenseDocumentRecognition = {
  status: RecognitionStatus;
  sourceKind: RecognitionSourceKind | null;
  result: ExpenseRecognitionResult | null;
  parserVersion: string;
  modelVersion: string;
  outdated: boolean;
  lastError: string | null;
  attempts: number;
  updatedAt: string;
};

/** 策略版本决定是否过期，实际生成厂商只用于溯源。 */
export function recognitionModelVersionMatches(stored: string, current: string): boolean {
  return stored.split("|served:")[0] === current;
}
