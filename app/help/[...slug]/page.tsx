import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { cookies } from "next/headers";
import { getSession } from "@/lib/account/session";
import { loadManual, getManualNeighbors } from "@/lib/help/manual";
import { loadChangelog, changelogForPage, formatChangelogDate } from "@/lib/help/changelog";
import HelpSidebar from "@/components/help/HelpSidebar";
import HelpScope from "@/components/help/HelpScope";
import HelpToc from "@/components/help/HelpToc";
import HelpMarkdown from "@/components/help/HelpMarkdown";
import HelpReportEntry from "@/components/help/HelpReportEntry";

type Params = { slug: string[] };

export async function generateMetadata({ params }: { params: Promise<Params> }): Promise<Metadata> {
  const { slug } = await params;
  const page = loadManual().pages.find((p) => p.slug === slug.join("/"));
  return page ? { title: page.title, description: page.summary ?? undefined } : {};
}

export default async function HelpArticle({ params }: { params: Promise<Params> }) {
  const { slug: parts } = await params;
  const slug = parts.join("/");
  const manual = loadManual();
  const page = manual.pages.find((p) => p.slug === slug);
  if (!page) notFound();

  const section = manual.sections.find((s) => s.slug === page.sectionSlug)!;
  const group = section.groups.find((g) => g.slug === page.groupSlug)!;
  const { prev, next } = getManualNeighbors(slug);
  // 「报告问题」只给登录用户（#538）：手册是公开页，匿名表单等于开刷库口
  const loggedIn = getSession(await cookies()) !== null;
  const related = page.related.map((s) => manual.pages.find((p) => p.slug === s)).filter((p) => p != null);
  // 「本页功能有更新」（#569 B3）：最近一个提到这页的已发版本；未发版的条目不算——手册写的是线上现状
  const changes = changelogForPage(loadChangelog(), slug);

  return (
    <div className="help-frame">
      <aside className="help-aside"><HelpSidebar manual={manual} currentSlug={slug} /></aside>

      <main className="help-main">
        <details className="help-mobile-tree">
          <summary>目录</summary>
          <HelpSidebar manual={manual} currentSlug={slug} />
        </details>

        <article className="help-article">
          <nav className="help-crumbs" aria-label="位置">
            <Link href="/help">使用手册</Link><span>›</span>
            <span>{section.title}</span><span>›</span>
            <span>{group.title}</span>
          </nav>
          <h1 className="help-title">{page.title}</h1>
          {page.summary && <p className="help-summary">{page.summary}</p>}
          {page.updated && <div className="help-updated">更新于 {page.updated}</div>}
          <HelpScope page={page} />
          {changes && (
            <aside className="help-page-changes">
              <Link href={`/help/changelog#${changes.version.version}`}>{formatChangelogDate(changes.version.date)}的更新</Link>改了这页说的功能：
              <ul>{changes.entries.map((e) => <li key={e.id}>{e.title}</li>)}</ul>
            </aside>
          )}
          <HelpMarkdown body={page.body} slug={slug} />

          <HelpReportEntry slug={slug} loggedIn={loggedIn} />

          {related.length > 0 && (
            <section className="help-related">
              <h2>相关文章</h2>
              <ul>{related.map((p) => <li key={p.slug}><Link href={`/help/${p.slug}`}>{p.title}</Link></li>)}</ul>
            </section>
          )}
        </article>

        <nav className="help-pager" aria-label="上一页 / 下一页">
          {prev && <Link href={`/help/${prev.slug}`} className="is-prev"><small>上一页</small><span>‹ {prev.title}</span></Link>}
          {next && <Link href={`/help/${next.slug}`} className="is-next"><small>下一页</small><span>{next.title} ›</span></Link>}
        </nav>
      </main>

      <aside className="help-aside"><HelpToc headings={page.headings} /></aside>
    </div>
  );
}
