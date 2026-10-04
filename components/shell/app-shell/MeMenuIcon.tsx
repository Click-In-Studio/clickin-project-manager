import type { ReactNode } from "react";

export type MeMenuIconName =
  | "profile"
  | "security"
  | "preferences"
  | "help"
  | "manual"
  | "admin"
  | "changelog"
  | "report";

/**
 * 「我」抽屉的语义线框图标。全部共用同一画布、线宽和圆角端点，
 * 颜色跟随 NavItem 的 currentColor，不引入外部图标或品牌资源。
 */
export default function MeMenuIcon({ name }: { name: MeMenuIconName }) {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      data-me-menu-icon={name}
      className="h-4 w-4 fill-none stroke-current"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {iconPaths[name]}
    </svg>
  );
}

const iconPaths: Record<MeMenuIconName, ReactNode> = {
  profile: (
    <>
      <rect x="4" y="3.5" width="16" height="17" rx="3" />
      <circle cx="12" cy="9" r="2.5" />
      <path d="M7.5 17c.7-2.3 2.2-3.5 4.5-3.5s3.8 1.2 4.5 3.5" />
    </>
  ),
  security: (
    <>
      <path d="M12 3.2c2 1.5 4.2 2.3 6.5 2.5v5.2c0 4.4-2.2 7.7-6.5 9.9-4.3-2.2-6.5-5.5-6.5-9.9V5.7C7.8 5.5 10 4.7 12 3.2Z" />
      <path d="m9.2 11.8 1.8 1.8 3.9-4" />
    </>
  ),
  preferences: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M9.8 3.8 10.4 2h3.2l.6 1.8 1.6.7 1.7-.9 2.3 2.3-.9 1.7.7 1.6 1.8.6V13l-1.8.6-.7 1.6.9 1.7-2.3 2.3-1.7-.9-1.6.7-.6 1.8h-3.2L9.8 19l-1.6-.7-1.7.9-2.3-2.3.9-1.7-.7-1.6-1.8-.6V9.8l1.8-.6.7-1.6-.9-1.7 2.3-2.3 1.7.9 1.6-.7Z" />
    </>
  ),
  help: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M9.7 9a2.4 2.4 0 1 1 3.5 2.2c-.8.4-1.2 1-1.2 1.8v.3" />
      <path d="M12 17h.01" />
    </>
  ),
  manual: (
    <>
      <path d="M3.5 5.5c2.7-.7 5.1-.2 7.2 1.4v11.6c-2.1-1.6-4.5-2.1-7.2-1.4V5.5Z" />
      <path d="M10.7 6.9c2.1-1.6 4.5-2.1 7.2-1.4v5.1" />
      <circle cx="17.1" cy="15.1" r="3.1" />
      <path d="m19.4 17.4 1.6 1.6" />
    </>
  ),
  admin: (
    <>
      <path d="M14.3 5.1a4 4 0 0 0-5.4 4.8l-5.4 5.4a2.1 2.1 0 0 0 3 3l5.4-5.4a4 4 0 0 0 4.8-5.4l-2.4 2.4-2.2-.5-.5-2.2 2.7-2.1Z" />
      <path d="m5 16.8.1.1" />
    </>
  ),
  changelog: (
    <>
      <path d="M4.2 9a8.3 8.3 0 1 1-.1 6.1" />
      <path d="M4.2 4.8V9h4.2" />
      <path d="M12 7.5V12l3 1.8" />
    </>
  ),
  report: (
    <>
      <path d="M5.2 4.5h13.6a2.2 2.2 0 0 1 2.2 2.2v8.1a2.2 2.2 0 0 1-2.2 2.2h-7.2l-4.9 3v-3H5.2A2.2 2.2 0 0 1 3 14.8V6.7a2.2 2.2 0 0 1 2.2-2.2Z" />
      <path d="M12 8v4" />
      <path d="M12 14.2h.01" />
    </>
  ),
};
