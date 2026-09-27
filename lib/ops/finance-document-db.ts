import { getPool } from "../pg";

export type FinancialDocumentAsset = {
  assetId: string;
  assetFileId: string;
  uploaderUserId: string;
  fileName: string;
  mimeType: string | null;
  r2Key: string | null;
  linkedExpenses: {
    submittedBy: string;
    status: string;
    currentApproverIds: string[];
  }[];
};

/** 财务凭证的上下文读面；不走通用 asset grant。 */
export async function getFinancialDocumentAsset(
  productionId: string,
  assetId: string,
): Promise<FinancialDocumentAsset | null> {
  const { rows } = await getPool().query<{
    asset_id: string;
    asset_file_id: string;
    uploader_user_id: string;
    file_name: string;
    mime_type: string | null;
    r2_key: string | null;
    linked_expenses: FinancialDocumentAsset["linkedExpenses"];
  }>(
    `SELECT a.id AS asset_id, af.id AS asset_file_id, a.uploader_user_id,
            a.file_name, a.mime_type, af.r2_key,
            COALESCE((
              SELECT jsonb_agg(jsonb_build_object(
                'submittedBy', e.submitted_by,
                'status', e.status,
                'currentApproverIds', e.current_approver_ids
              ))
                FROM production_expense_document d
                JOIN production_expense e ON e.id = d.expense_id
               WHERE d.asset_file_id = af.id
            ), '[]'::jsonb) AS linked_expenses
       FROM asset a
       JOIN asset_file af ON af.asset_id = a.id
      WHERE a.id = $1 AND a.production_id = $2
        AND a.asset_type = 'financial_document'
        AND a.file_version_policy = 'single'`,
    [assetId, productionId],
  );
  const row = rows[0];
  return row ? {
    assetId: row.asset_id,
    assetFileId: row.asset_file_id,
    uploaderUserId: row.uploader_user_id,
    fileName: row.file_name,
    mimeType: row.mime_type,
    r2Key: row.r2_key,
    linkedExpenses: row.linked_expenses,
  } : null;
}
