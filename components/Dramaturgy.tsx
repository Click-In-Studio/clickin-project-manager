"use client";

import { useState } from "react";
import Link from "next/link";
import ScenesManager from "./ScenesManager";
import CharactersManager from "./CharactersManager";
import VersionSelector from "./VersionSelector";
import { BASE_PATH } from "@/lib/base-path";
import type { SceneDetail, CharacterDetail, Version } from "@/lib/db";

type Tab = "scenes" | "characters";

type Props = {
  productionId: string;
  productionName: string;
  versions: Version[];
  versionId: string | null;
  initialScenes: SceneDetail[];
  rehearsalMarks: Record<string, string[]>;
  initialCharacters: CharacterDetail[];
  canEdit: boolean;
  canImport?: boolean;
  initialSceneId?: string;
  initialCharacterId?: string;
};

function isUpdatingResponse(payload: unknown): payload is { status: "updating" } {
  return typeof payload === "object" && payload !== null && "status" in payload && payload.status === "updating";
}

export default function Dramaturgy({
  productionId,
  productionName,
  versions,
  versionId: initialVersionId,
  initialScenes,
  rehearsalMarks: initialRehearsalMarks,
  initialCharacters,
  canEdit,
  canImport,
  initialSceneId,
  initialCharacterId,
}: Props) {
  // sceneId takes precedence over characterId
  const [tab, setTab] = useState<Tab>(
    initialCharacterId && !initialSceneId ? "characters" : "scenes"
  );
  const [currentVersionId, setCurrentVersionId] = useState<string | null>(initialVersionId);
  const [scenes, setScenes] = useState<SceneDetail[]>(initialScenes);
  const [rehearsalMarks, setRehearsalMarks] = useState<Record<string, string[]>>(initialRehearsalMarks);
  const [characters, setCharacters] = useState<CharacterDetail[]>(initialCharacters);

  const handleVersionChange = async (versionId: string) => {
    const [scenePayload, charsData] = await Promise.all([
      fetch(`${BASE_PATH}/api/production/${productionId}/scenes?versionId=${versionId}&includeRehearsalMarks=1`).then(r => r.json()),
      fetch(`${BASE_PATH}/api/production/${productionId}/characters?versionId=${versionId}`).then(r => r.json()),
    ]);
    if (isUpdatingResponse(scenePayload) || isUpdatingResponse(charsData)) {
      return;
    }
    setScenes(scenePayload.scenes);
    setCharacters(charsData);
    setRehearsalMarks(scenePayload.rehearsalMarks);
    setCurrentVersionId(versionId);
  };

  const currentVersion = versions.find(v => v.id === currentVersionId);
  const effectiveCanEdit = canEdit && (!currentVersion || currentVersion.status === "editing" || currentVersion.status === "committed");

  return (
    <div className="min-h-screen bg-zinc-100 px-4 py-8">
      <div className="mx-auto max-w-2xl">
        <div className="mb-6 flex items-center justify-between">
          <Link href={`/production/${productionId}`} className="text-xs text-zinc-400 hover:text-zinc-600 transition-colors">
            ← 返回
          </Link>
          <div className="text-right flex flex-col items-end gap-1">
            <p className="text-xs font-semibold tracking-widest text-zinc-300 uppercase">Dramaturgy</p>
            <p className="text-sm font-bold text-zinc-500">{productionName}</p>
            <div className="flex items-center justify-end gap-1.5">
              {versions.length > 0 && (
                <VersionSelector
                  productionId={productionId}
                  versions={versions}
                  currentVersionId={currentVersionId}
                  canManage={canEdit}
                  onChange={handleVersionChange}
                />
              )}
              <span className="shrink-0 rounded bg-zinc-200 px-2 py-0.5 text-[11px] text-zinc-500">
                {effectiveCanEdit ? "可编辑" : "只读"}
              </span>
            </div>
            {canImport && tab === "scenes" && (
              <Link href={`/production/${productionId}/import-script`} className="text-xs text-blue-500 hover:underline">
                导入
              </Link>
            )}
          </div>
        </div>

        {/* Tabs */}
        <div className="mb-4 flex gap-1 rounded-xl bg-white p-1 shadow-sm">
          {(["scenes", "characters"] as Tab[]).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`flex-1 rounded-lg py-2 text-sm font-medium transition-colors ${
                tab === t
                  ? "bg-zinc-800 text-white"
                  : "text-zinc-400 hover:text-zinc-600"
              }`}
            >
              {t === "scenes" ? "章节" : "角色"}
            </button>
          ))}
        </div>

        {tab === "scenes" ? (
          <ScenesManager
            key={currentVersionId ?? ""}
            productionId={productionId}
            productionName={productionName}
            initialScenes={scenes}
            rehearsalMarks={rehearsalMarks}
            canEdit={effectiveCanEdit}
            versionId={currentVersionId}
            initialExpandedId={initialSceneId}
            embedded
          />
        ) : (
          <CharactersManager
            key={currentVersionId ?? ""}
            productionId={productionId}
            productionName={productionName}
            initialCharacters={characters}
            canEdit={effectiveCanEdit}
            initialExpandedId={initialCharacterId}
            embedded
          />
        )}
      </div>
    </div>
  );
}
