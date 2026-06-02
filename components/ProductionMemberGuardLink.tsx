"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { BASE_PATH } from "@/lib/base-path";

type Props = {
  productionId: string;
  currentOpenId: string;
  href: string;
  title: string;
  subtitle: string;
  accountName: string;
  isProjectMember: boolean;
  isAdmin?: boolean;
  className?: string;
  children?: React.ReactNode;
};

export default function ProductionMemberGuardLink({
  productionId,
  currentOpenId,
  href,
  title,
  subtitle,
  accountName,
  isProjectMember,
  isAdmin = false,
  className,
  children,
}: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [joining, setJoining] = useState(false);

  const joinProject = async () => {
    setJoining(true);
    try {
      const res = await fetch(`${BASE_PATH}/api/production/${productionId}/members`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ openId: currentOpenId }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        alert(data?.error ?? "加入项目失败");
        return;
      }
      setOpen(false);
      router.refresh();
    } catch {
      alert("网络错误，请重试");
    } finally {
      setJoining(false);
    }
  };

  const cardContent = children ?? (
    <>
      <p className="text-xs font-semibold tracking-widest text-zinc-300 uppercase mb-1">{subtitle}</p>
      <p className="text-base font-medium text-zinc-700">{title}</p>
    </>
  );

  if (isProjectMember) {
    return (
      <Link href={href} className={className}>
        {cardContent}
      </Link>
    );
  }

  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className={className}>
        {cardContent}
      </button>
      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 px-4"
          onClick={() => setOpen(false)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="member-guard-title"
            onClick={e => e.stopPropagation()}
            className="w-full max-w-sm rounded-xl bg-white p-5 text-left shadow-xl"
          >
            <p id="member-guard-title" className="text-sm font-semibold text-zinc-800">无法编辑项目内容</p>
            <p className="mt-3 text-sm leading-6 text-zinc-600">
              {isAdmin
                ? <>当前超级管理员账号（{accountName}）还不是该项目的成员。请将自己加入项目人员以继续。</>
                : <>当前账号（{accountName}）还不是该项目的成员。如需编辑，请联系管理员将当前账号加入该项目。</>}
            </p>
            <div className="mt-5 flex justify-end gap-2">
              {isAdmin && (
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  disabled={joining}
                  className="rounded-md px-3 py-1.5 text-xs font-medium text-zinc-500 hover:bg-zinc-100 disabled:opacity-50"
                >
                  取消
                </button>
              )}
              <button
                type="button"
                onClick={isAdmin ? joinProject : () => setOpen(false)}
                disabled={isAdmin && joining}
                className="rounded-md bg-zinc-800 px-3 py-1.5 text-xs font-medium text-white hover:bg-zinc-700"
              >
                {isAdmin ? (joining ? "加入中…" : "加入项目") : "知道了"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
