"use client";

import { DataCard, type SettingsPerms } from "@/components/AdminSettingsClient";

const NO_PERMS: SettingsPerms = {
  canRename: false, canChangeAvatar: false, canEditDescription: false,
  canChangeType: false, canChangeLanguage: false, canArchive: false, canDelete: false,
  canImportScript: false, canImportScenes: false,
  canManageTags: false, canToggleWatermark: false, canEditAiInstructions: false,
  canSeeAiUsage: false, canSeeAiUsageMembers: false,
};

export default function AdminMigrationSection({
  productionId, canImportScript, canImportScenes,
}: {
  productionId: string;
  canImportScript: boolean;
  canImportScenes: boolean;
}) {
  return (
    <DataCard
      productionId={productionId}
      perms={{ ...NO_PERMS, canImportScript, canImportScenes }}
    />
  );
}
