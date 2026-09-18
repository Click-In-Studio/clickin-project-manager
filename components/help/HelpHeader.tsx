// 手册站点顶栏（#531）：独立于 AppShell——手册是给未登录的外人看的帮助中心，
// 不该背着整套产品侧栏。搜索框壳子阶段只是占位（客户端索引在收尾 issue #538）。

import Link from "next/link";

export default function HelpHeader() {
  return (
    <header className="help-header">
      <div className="help-header-inner">
        <Link href="/help" className="help-brand">
          <span className="help-brand-mark">B</span>
          <span className="help-brand-text">Backstage <span>使用手册</span></span>
        </Link>
        <label className="help-search" title="搜索即将上线">
          <span aria-hidden>⌕</span>
          <input type="search" placeholder="搜索手册（即将上线）" disabled aria-label="搜索手册" />
        </label>
        <Link href="/" className="help-open-app">打开 Backstage</Link>
      </div>
    </header>
  );
}
