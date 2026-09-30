import { getAsset, type Asset } from "./db";

export const ASSET_FILE_POLICY_SINGLE_CODE = "asset_file_policy_single";

export type AssetVersionUploadError = {
  status: 400 | 404 | 409;
  message: string;
  code?: typeof ASSET_FILE_POLICY_SINGLE_CODE;
};

/**
 * “上传新版本”的目标校验。权限仍由调用路由先判；这里只收口资源归属、存储形态
 * 和创建时写定的文件策略，使 presign / multipart / relay / 注册使用同一口径。
 */
export function assetVersionUploadError(
  asset: Pick<Asset, "productionId" | "storageType" | "fileVersionPolicy"> | null,
  productionId: string,
): AssetVersionUploadError | null {
  if (!asset || asset.productionId !== productionId)
    return { status: 404, message: "不存在" };
  if (asset.storageType !== "r2")
    return { status: 400, message: "非 R2 文件，无法上传新版本" };
  if (asset.fileVersionPolicy === "single") {
    return {
      status: 409,
      message: "该资产不支持上传新版本",
      code: ASSET_FILE_POLICY_SINGLE_CODE,
    };
  }
  return null;
}

export async function getAssetVersionUploadError(
  productionId: string,
  assetId?: string | null,
): Promise<AssetVersionUploadError | null> {
  if (!assetId) return null;
  return assetVersionUploadError(await getAsset(assetId), productionId);
}

export function assetVersionUploadErrorResponse(error: AssetVersionUploadError): Response {
  return Response.json(
    error.code ? { error: error.message, code: error.code } : { error: error.message },
    { status: error.status },
  );
}
