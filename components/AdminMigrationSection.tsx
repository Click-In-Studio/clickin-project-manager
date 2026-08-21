"use client";

import { DataCard, type SettingsPerms } from "@/components/AdminSettingsClient";

const NO_PERMS: SettingsPerms = {
  canRename: false, canChangeAvatar: false, canEditDescription: false,
  canChangeType: false, canChangeLanguage: false, canArchive: false, canDelete: false,
  canImportContacts: false, canImportScript: false, canImportScenes: false,
  canManageTags: false, canToggleWatermark: false, canEditAiInstructions: false,
};

export default function AdminMigrationSection({
  productionId, canImportContacts, canImportScript, canImportScenes,
}: {
  productionId: string;
  canImportContacts: boolean;
  canImportScript: boolean;
  canImportScenes: boolean;
}) {
  return (
    <DataCard
      productionId={productionId}
      perms={{ ...NO_PERMS, canImportContacts, canImportScript, canImportScenes }}
    />
  );
}
