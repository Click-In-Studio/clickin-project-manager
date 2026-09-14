"use client";

import type { Scene } from "@/lib/script/script-types";

export default function SceneLabel({ scene, focused = false }: { scene: Scene; focused?: boolean }) {
  return (
    <span
      title={scene.name ? `${scene.number} ${scene.name}` : scene.number}
      className={`pointer-events-none select-none rounded px-1.5 py-0.5 text-[11px] font-bold tracking-wide transition-colors ${
        focused ? "text-zinc-600" : "text-zinc-300 group-hover:text-zinc-500"
      }`}
    >
      {scene.number}
    </span>
  );
}
