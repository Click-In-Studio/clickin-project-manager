import type { AssetType } from "./types";

export type UploadResult = {
  assetId: string;
  fileId: string;
  name: string | null;
  fileName: string;
  assetType: AssetType;
  storageType: "r2" | "feishu_link";
};
