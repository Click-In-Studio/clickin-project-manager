"use client";

import { useState } from "react";
import { productionAvatarSrc } from "@/lib/asset/avatar-url";
import { firstContentChar } from "./first-content-char";

export default function ProdAvatarIcon({ productionId, avatarUrl, name }: { productionId: string; avatarUrl: string | null; name: string }) {
  const [failed, setFailed] = useState(false);
  const src = productionAvatarSrc(productionId, avatarUrl);
  if (failed || !src) {
    return <span className="text-white text-[11px] font-bold select-none">{firstContentChar(name)}</span>;
  }
  return (
    <img
      src={src}
      alt={name}
      className="w-full h-full object-cover"
      onError={() => setFailed(true)}
    />
  );
}
