import Link from "next/link";
import { loadManual } from "@/lib/help/manual";

// 手册首页：搜索占位 + 六张一级分类卡 + 三步上手 + 热门问题（飞书 / Slack 帮助中心
// 首页同款骨架）。三步上手与热门问题读 content/manual/_home.md。
export default function HelpHome() {
  const manual = loadManual();
  const bySlug = new Map(manual.pages.map((p) => [p.slug, p]));
  const quickstart = manual.home.quickstart.map((s) => bySlug.get(s)).filter((p) => p != null);
  const popular = manual.home.popular.map((s) => bySlug.get(s)).filter((p) => p != null);

  return (
    <div className="help-home">
      <section className="help-hero">
        <h1>Backstage 使用手册</h1>
        <p>从注册登录到剧本、Cue、日程、权限与 AI 助手——每个功能怎么用、谁能用、注意什么。</p>
        <label className="help-search" title="搜索即将上线">
          <span aria-hidden>⌕</span>
          <input type="search" placeholder="搜索手册（即将上线）" disabled aria-label="搜索手册" />
        </label>
      </section>

      <div className="help-cards">
        {manual.sections.map((sec, i) => {
          const first = sec.groups[0]?.pages[0];
          const count = sec.groups.reduce((n, g) => n + g.pages.length, 0);
          const inner = (
            <>
              <div className="help-card-n">{String(i + 1).padStart(2, "0")}</div>
              <h2>{sec.title}</h2>
              <p>{sec.summary}</p>
              <div className="help-card-meta">{count > 0 ? `${count} 篇` : "内容整理中"}</div>
            </>
          );
          return first
            ? <Link key={sec.slug} href={`/help/${first.slug}`} className="help-card">{inner}</Link>
            : <div key={sec.slug} className="help-card" aria-disabled>{inner}</div>;
        })}
      </div>

      {quickstart.length > 0 && (
        <section className="help-home-section">
          <h2>三步上手</h2>
          <ol className="help-steps">
            {quickstart.map((p) => (
              <li key={p.slug}><Link href={`/help/${p.slug}`}><strong>{p.title}</strong>{p.summary && <span>{p.summary}</span>}</Link></li>
            ))}
          </ol>
        </section>
      )}

      {popular.length > 0 && (
        <section className="help-home-section">
          <h2>常见问题</h2>
          <ul className="help-popular">
            {popular.map((p) => (
              <li key={p.slug}><Link href={`/help/${p.slug}`}>{p.title}{p.summary && <small>{p.summary}</small>}</Link></li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
