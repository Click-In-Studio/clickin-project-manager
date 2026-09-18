// 「适用范围」块（#531）：Slack "Who can use this feature?" / 飞书「适用范围」同款，
// 由 frontmatter 的 who / tier / platform 自动渲染，作者不手写。档位文案取
// PRODUCTION_TIERS 的 label——档位改名手册自动跟，不留第二份词表。

import { PRODUCTION_TIERS } from "@/lib/account/plan";
import type { ManualPage } from "@/lib/help/manual";

const PLATFORM_LABEL = { desktop: "桌面 / 宽窗口", mobile: "手机 / 窄窗口" } as const;

export default function HelpScope({ page }: { page: Pick<ManualPage, "who" | "tier" | "platform"> }) {
  const tierText = page.tier === "all"
    ? "所有档位"
    : page.tier === "pro"
      ? `${PRODUCTION_TIERS.pro.label}可用`
      : `${PRODUCTION_TIERS.free.label}起可用`;
  const rows: [string, string][] = [
    ["谁能用", page.who ?? "项目内所有成员"],
    ["档位", tierText],
    ["平台", page.platform.map((p) => PLATFORM_LABEL[p]).join(" · ")],
  ];
  return (
    <dl className="help-scope" aria-label="适用范围">
      <div className="help-scope-title">适用范围</div>
      {rows.map(([k, v]) => (
        <div key={k} className="help-scope-row">
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}
