"use client";

import { useState } from "react";
import Link from "next/link";
import ScenesManager from "./ScenesManager";
import CharactersManager from "./CharactersManager";
import type { SceneDetail, CharacterDetail } from "@/lib/db";

type Tab = "scenes" | "characters";

type Props = {
  productionId: string;
  productionName: string;
  initialScenes: SceneDetail[];
  rehearsalMarks: Record<string, string[]>;
  initialCharacters: CharacterDetail[];
  canEdit: boolean;
  canImport?: boolean;
};

export default function Dramaturgy({
  productionId,
  productionName,
  initialScenes,
  rehearsalMarks,
  initialCharacters,
  canEdit,
  canImport,
}: Props) {
  const [tab, setTab] = useState<Tab>("scenes");

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
            {canImport && tab === "scenes" && (
              <Link href={`/production/${productionId}/import-scenes`} className="text-xs text-blue-500 hover:underline">
                导入章节信息
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
            productionId={productionId}
            productionName={productionName}
            initialScenes={initialScenes}
            rehearsalMarks={rehearsalMarks}
            canEdit={canEdit}
            embedded
          />
        ) : (
          <CharactersManager
            productionId={productionId}
            productionName={productionName}
            initialCharacters={initialCharacters}
            canEdit={canEdit}
            embedded
          />
        )}
      </div>
    </div>
  );
}
