import Link from "next/link";

export default function HelpNotFound() {
  return (
    <div className="help-empty">
      <p style={{ fontFamily: 'Georgia, "Noto Serif SC", serif', fontSize: 28, margin: "0 0 8px", color: "var(--ink)" }}>这一页还没写</p>
      <p style={{ margin: "0 0 20px" }}>链接可能已变更，或者这个功能的说明正在整理中。</p>
      <Link href="/help" style={{ color: "var(--script)" }}>回到手册首页</Link>
    </div>
  );
}
