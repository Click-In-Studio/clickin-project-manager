import type { Metadata } from "next";
import Link from "next/link";
import { loadChangelog, latestChangelogVersion, groupByKind, formatChangelogDate, type ChangelogEntry } from "@/lib/help/changelog";
import { loadManual } from "@/lib/help/manual";
import HelpMarkdown from "@/components/help/HelpMarkdown";
import ChangelogSeen from "@/components/help/ChangelogSeen";

// 更新日志页（#569）：版本倒序，每版按 新增 / 优化 / 修复 / 下线 分组，每条可跳对应手册页。
// 静态路由优先于 /help/[...slug]，所以 /help/changelog 落到这里而不是找一篇叫 changelog 的手册页。
// dev 环境（main 自动发）unreleased/ 有条目时顶部多一段「即将发布」；prod 上发版已卷走。

export const metadata: Metadata = { title: "更新日志", description: "Backstage 每个版本新增了什么、修了什么" };

function EntryList({ entries, pageTitle }: { entries: ChangelogEntry[]; pageTitle: Map<string, string> }) {
  return (
    <ul className="help-changelog-list">
      {entries.map((e) => (
        <li key={e.id} title={e.pr ? `PR #${e.pr}` : undefined}>
          <strong>{e.title}</strong>
          {e.body && <HelpMarkdown body={e.body} slug="_changelog" />}
          {e.page && pageTitle.has(e.page) && (
            <Link href={`/help/${e.page}`} className="help-changelog-more">了解更多：{pageTitle.get(e.page)} →</Link>
          )}
        </li>
      ))}
    </ul>
  );
}

function Groups({ entries, pageTitle }: { entries: ChangelogEntry[]; pageTitle: Map<string, string> }) {
  return groupByKind(entries).map((g) => (
    <section key={g.kind} className={`help-changelog-group is-${g.kind}`}>
      <h3>{g.label}</h3>
      <EntryList entries={g.entries} pageTitle={pageTitle} />
    </section>
  ));
}

export default function ChangelogPage() {
  const log = loadChangelog();
  const latest = latestChangelogVersion(log);
  const pageTitle = new Map(loadManual().pages.map((p) => [p.slug, p.title]));

  return (
    <div className="help-changelog">
      <ChangelogSeen latest={latest} />
      <nav className="help-crumbs" aria-label="位置">
        <Link href="/help">使用手册</Link><span>›</span><span>更新日志</span>
      </nav>
      <h1 className="help-title">更新日志</h1>
      <p className="help-summary">每次发版后，新功能、改进和修复都记在这里。</p>

      {log.unreleased.length > 0 && (
        <article className="help-changelog-version is-unreleased" id="unreleased">
          <header>
            <h2>即将发布</h2>
            <p>已经做好、还没正式发版的改动。</p>
          </header>
          <Groups entries={log.unreleased} pageTitle={pageTitle} />
        </article>
      )}

      {log.versions.map((v) => (
        <article key={v.version} className="help-changelog-version" id={v.version}>
          <header>
            <h2>{formatChangelogDate(v.date)}<span className="help-changelog-tag">{v.version}</span></h2>
            {v.summary && <p>{v.summary}</p>}
          </header>
          {v.entries.length === 0
            ? <p className="help-changelog-empty">这一版没有你能感知到的改动。</p>
            : <Groups entries={v.entries} pageTitle={pageTitle} />}
        </article>
      ))}
    </div>
  );
}
