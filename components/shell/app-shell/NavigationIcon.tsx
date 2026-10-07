import type { ReactNode } from "react";
import MeMenuIcon from "./MeMenuIcon";

export type NavigationIconName =
  | "home" | "projects" | "announcement" | "notification" | "approval"
  | "person" | "calendar" | "task" | "report" | "dramaturgy" | "script"
  | "cue" | "knowledge" | "outline" | "finance" | "event" | "material" | "asset"
  | "overview" | "creation" | "production" | "settings" | "back"
  | "milestone" | "organization" | "roles" | "permissions" | "approval-flow"
  | "templates" | "policies" | "audit" | "asset-review" | "project-info"
  | "producer" | "migration" | "danger";

/** 导航共用语义图形；颜色由所在导航容器决定，人员复用个人信息图标。 */
export default function NavigationIcon({ name }: { name: NavigationIconName }) {
  if (name === "person") return <MeMenuIcon name="profile" />;
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      data-navigation-icon={name}
      className="h-4 w-4 fill-none stroke-current"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {iconPaths[name]}
    </svg>
  );
}

const iconPaths: Record<Exclude<NavigationIconName, "person">, ReactNode> = {
  home: <><path d="m3 10 9-7 9 7M5 9v11h5v-6h4v6h5V9" /></>,
  projects: <><rect x="7" y="7" width="14" height="14" rx="2" /><path d="M17 7V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h2" /></>,
  announcement: <><path d="M8 4H5a1 1 0 0 0-1 1v15a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1V5a1 1 0 0 0-1-1h-3M8 14h8M8 17h6" /><path d="M10 2h4l-.5 4L16 9H8l2.5-3L10 2ZM12 9v3" /></>,
  notification: <><path d="M4 10h5l10-5v14L9 14H4v-4ZM9 10v4M6 14l1 6h3l-1-6M22 9v6" /></>,
  approval: <><path d="M9 12V9c0-2-2-2.5-2-4a5 3 0 0 1 10 0c0 1.5-2 2-2 4v3M7 12h10l2 5H5l2-5ZM4 21h16" /></>,
  calendar: <><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M7 3v4M17 3v4M3 10h18M7 14h2M13 14h2M7 17h2" /></>,
  task: <><path d="M19 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h8M7 11h3M7 16h6" /><path d="m13 7 3 3 6-7" /></>,
  report: <><path d="M14 3H5v18h14V8l-5-5ZM14 3v5h5M8 12h8M8 16h6" /></>,
  dramaturgy: <><rect x="2" y="3" width="8" height="7" rx="1.5" /><rect x="14" y="14" width="8" height="7" rx="1.5" /><path d="M10 6h8v8M6 10v7h8M5 6h2M17 17h2" /></>,
  script: <><path d="M12 5C9 3 6 3 3 4v15c3-1 6-1 9 1 3-2 6-2 9-1V4c-3-1-6-1-9 1ZM12 5v15M6 8h3M6 12h3M15 8h3M15 12h3" /></>,
  cue: <><path d="M5 3v12M5 4h12l-3 3 3 3H5M3 19h18M5 17v4M9 18v2M13 17v4M17 18v2M21 17v4" /></>,
  knowledge: <><path d="M6 3h14v18H6a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3ZM3 18a3 3 0 0 1 3-3h14M12 3v8l3-2 3 2V3" /></>,
  outline: <><path d="M9 5h11M9 12h11M9 19h11" /><path d="M4 5h1M4 12h1M4 19h1" /></>,
  finance: <><circle cx="12" cy="12" r="9" /><path d="m8 7 4 5 4-5M12 12v6M8 12h8M8 15h8" /></>,
  event: <><path d="M3 9h18v12H3V9ZM3 9 2 5l17-4 1 4L3 9ZM7 4l3 3M13 3l3 3M7 14h10" /></>,
  material: <><path d="m3 7 9-4 9 4v13H3V7ZM3 7l9 4 9-4M12 11v9M8 5l9 4M7 15h2" /></>,
  asset: <><path d="M11 20H3V5h7l2 3h9v3" /><path d="m14 16 4-4a2.1 2.1 0 0 1 3 3l-5 5a3.2 3.2 0 0 1-4.5-4.5l4.5-4.5M14 17l4-4" /></>,
  overview: <><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></>,
  creation: <><path d="m4 16-1 5 5-1L20 8l-4-4L4 16ZM13 7l4 4M4 16l4 4M18 2l4 4" /></>,
  production: <><path d="M3 4h18v16H3V4ZM3 7h18M8 7v13M16 7v13M3 13h5M16 13h5M10 20l2-4 2 4" /></>,
  settings: <><path d="M4 6h2M10 6h10M4 12h10M18 12h2M4 18h4M12 18h8" /><circle cx="8" cy="6" r="2" /><circle cx="16" cy="12" r="2" /><circle cx="10" cy="18" r="2" /></>,
  back: <><path d="m10 5-7 7 7 7M3 12h18" /></>,
  milestone: <><path d="M5 21V3h14l-3 4 3 4H5M3 21h6" /></>,
  organization: <><rect x="9" y="3" width="6" height="5" rx="1" /><rect x="2" y="16" width="6" height="5" rx="1" /><rect x="16" y="16" width="6" height="5" rx="1" /><path d="M12 8v4M5 16v-4h14v4" /></>,
  roles: <><path d="m12 3 3 3 4 1-1 4 1 4-4 1-3 3-3-3-4-1 1-4-1-4 4-1 3-3ZM7 17l-2 5 5-2M17 17l2 5-5-2" /><circle cx="12" cy="11" r="3" /></>,
  permissions: <><circle cx="8" cy="9" r="5" /><path d="m12 13 8 8M16 17l3-3M19 20l3-3" /></>,
  "approval-flow": <><rect x="3" y="3" width="7" height="6" rx="1" /><rect x="14" y="15" width="7" height="6" rx="1" /><path d="M10 6h7v6m-3-3 3 3 3-3M3 15h7v6H3z" /></>,
  templates: <><path d="M8 3h12v14M4 7h12v14H4V7ZM7 11h6M7 15h6M7 18h4" /></>,
  policies: <><path d="M4 6h16M4 12h16M4 18h16M8 3v6M16 9v6M10 15v6" /></>,
  audit: <><path d="M12 3H4v18h10M7 7h5M7 11h3" /><circle cx="16" cy="13" r="4" /><path d="m19 16 3 3" /></>,
  "asset-review": <><path d="M10 20H3V5h7l2 3h9v3" /><path d="M12 15s2-3 5-3 5 3 5 3-2 3-5 3-5-3-5-3Z" /><circle cx="17" cy="15" r="1" /></>,
  "project-info": <><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M12 11v6M12 7h.01" /></>,
  producer: <><path d="m4 7 4 3 4-7 4 7 4-3-2 10H6L4 7ZM6 21h12" /></>,
  migration: <><path d="M3 4h7v7H3V4ZM14 13h7v7h-7v-7ZM14 5h6v5m-3-8 3 3-3 3M10 19H4v-5m3 8-3-3 3-3" /></>,
  danger: <><path d="m12 3 10 18H2L12 3ZM12 9v5M12 17h.01" /></>,
};
