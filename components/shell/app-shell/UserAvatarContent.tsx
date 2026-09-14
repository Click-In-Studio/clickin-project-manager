"use client";

import { useState } from "react";

export default function UserAvatarContent({
  src,
  initial,
  compact = false,
}: {
  src: string | null;
  initial: string;
  compact?: boolean;
}) {
  const [failed, setFailed] = useState(false);
  const sizeClass = compact ? "h-5 w-5 rounded-full" : "h-full w-full";

  if (!src || failed) {
    return (
      <span className={`${sizeClass} flex items-center justify-center bg-[#182a2a] text-[9px] font-bold text-white`}>
        {initial}
      </span>
    );
  }

  return (
    <img
      src={src}
      alt=""
      className={`${sizeClass} object-cover`}
      onError={() => setFailed(true)}
    />
  );
}
