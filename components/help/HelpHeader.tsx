// 手册站点顶栏（#531）：独立于 AppShell——手册是给未登录的外人看的帮助中心，
// 不该背着整套产品侧栏。搜索是客户端过滤（#538，索引来自 /api/help/search-index）。

import Link from "next/link";
import HelpSearch from "./HelpSearch";

export default function HelpHeader() {
  return (
    <header className="help-header">
      <div className="help-header-inner">
        <Link href="/help" className="help-brand">
          <span className="help-brand-mark">B</span>
          <span className="help-brand-text">Backstage <span>使用手册</span></span>
        </Link>
        <HelpSearch />
        <Link href="/" className="help-open-app">打开 Backstage</Link>
      </div>
    </header>
  );
}
