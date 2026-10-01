import { getPool } from "@/lib/pg";
import type {
  ExpenseDocumentRecognition, ExpenseRecognitionResult, RecognitionSourceKind, RecognitionStatus,
} from "./expense-recognition-types";

type RecognitionRow = {
  asset_file_id: string;
  status: RecognitionStatus;
  source_kind: RecognitionSourceKind | null;
  result: ExpenseRecognitionResult | null;
  parser_version: string;
  model_version: string;
  last_error: string | null;
  attempts: number;
  updated_at: Date;
};

export function recognitionFromRow(
  row: RecognitionRow,
  current: { parserVersion: string; modelVersion: string },
): ExpenseDocumentRecognition {
  return {
    status: row.status,
    sourceKind: row.source_kind,
    result: row.result,
    parserVersion: row.parser_version,
    modelVersion: row.model_version,
    outdated: row.parser_version !== current.parserVersion || row.model_version !== current.modelVersion,
    lastError: row.last_error,
    attempts: row.attempts,
    updatedAt: row.updated_at.toISOString(),
  };
}

const COLUMNS = `asset_file_id, status, source_kind, result, parser_version, model_version,
                 last_error, attempts, updated_at`;

export async function getExpenseDocumentRecognition(
  assetFileId: string,
  current: { parserVersion: string; modelVersion: string },
): Promise<ExpenseDocumentRecognition | null> {
  const { rows } = await getPool().query<RecognitionRow>(
    `SELECT ${COLUMNS} FROM expense_document_recognition WHERE asset_file_id = $1`,
    [assetFileId],
  );
  return rows[0] ? recognitionFromRow(rows[0], current) : null;
}

export async function queueExpenseDocumentRecognitionRow(
  assetFileId: string,
  versions: { parserVersion: string; modelVersion: string },
  force = false,
): Promise<void> {
  await getPool().query(
    `INSERT INTO expense_document_recognition
       (asset_file_id, status, parser_version, model_version)
     VALUES ($1, 'queued', $2, $3)
     ON CONFLICT (asset_file_id) DO UPDATE
       SET status = 'queued', source_kind = NULL, result = NULL,
           parser_version = EXCLUDED.parser_version, model_version = EXCLUDED.model_version,
           last_error = NULL, started_at = NULL, finished_at = NULL, updated_at = now()
     WHERE $4::boolean
        OR expense_document_recognition.parser_version <> EXCLUDED.parser_version
        OR expense_document_recognition.model_version <> EXCLUDED.model_version`,
    [assetFileId, versions.parserVersion, versions.modelVersion, force],
  );
}

export async function markExpenseDocumentRecognitionProcessing(assetFileId: string): Promise<void> {
  await getPool().query(
    `UPDATE expense_document_recognition
        SET status = 'processing', attempts = attempts + 1, last_error = NULL,
            started_at = COALESCE(started_at, now()), finished_at = NULL, updated_at = now()
      WHERE asset_file_id = $1`,
    [assetFileId],
  );
}

export async function finishExpenseDocumentRecognition(
  assetFileId: string,
  sourceKind: RecognitionSourceKind,
  result: ExpenseRecognitionResult,
): Promise<void> {
  await getPool().query(
    `UPDATE expense_document_recognition
        SET status = 'succeeded', source_kind = $2, result = $3::jsonb,
            last_error = NULL, finished_at = now(), updated_at = now()
      WHERE asset_file_id = $1`,
    [assetFileId, sourceKind, JSON.stringify(result)],
  );
}

export async function failExpenseDocumentRecognition(
  assetFileId: string,
  status: "queued" | "failed" | "unavailable",
  message: string,
): Promise<void> {
  await getPool().query(
    `UPDATE expense_document_recognition
        SET status = $2, result = NULL, last_error = $3,
            finished_at = CASE WHEN $2 = 'queued' THEN NULL ELSE now() END,
            updated_at = now()
      WHERE asset_file_id = $1`,
    [assetFileId, status, message.slice(0, 2000)],
  );
}
