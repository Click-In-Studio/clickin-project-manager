// 手册左侧分组树（#531）：一级 → 二级 → 文章三层，纯服务端渲染，折叠用 <details>
// 不带客户端 JS。当前文章所在的一级/二级默认展开，其余一级折叠。
// 窄窗口下整棵树收进顶部的「目录」<details>（HelpArticleFrame 负责），这里只管树本身。

import Link from "next/link";
import type { Manual } from "@/lib/help/manual";

export default function HelpSidebar({ manual, currentSlug }: { manual: Manual; currentSlug: string | null }) {
  const currentSection = currentSlug?.split("/")[0] ?? null;
  const currentGroup = currentSlug ? currentSlug.split("/").slice(0, 2).join("/") : null;
  return (
    <nav className="help-tree" aria-label="手册目录">
      {manual.sections.map((sec) => (
        <details key={sec.slug} open={sec.slug === currentSection} className="help-tree-section">
          <summary>{sec.title}</summary>
          {sec.groups.length === 0 ? (
            <p className="help-tree-empty">内容整理中</p>
          ) : sec.groups.map((grp) => (
            <div key={grp.slug} className="help-tree-group">
              <div className={`help-tree-group-title${`${sec.slug}/${grp.slug}` === currentGroup ? " is-current" : ""}`}>{grp.title}</div>
              <ul>
                {grp.pages.map((p) => (
                  <li key={p.slug}>
                    <Link href={`/help/${p.slug}`} aria-current={p.slug === currentSlug ? "page" : undefined} className={p.slug === currentSlug ? "is-current" : undefined}>
                      {p.title}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </details>
      ))}
    </nav>
  );
}
