import Link from "next/link";

export default function NotFound() {
  return (
    <div style={{
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      justifyContent: "center",
      minHeight: "100dvh",
      padding: "40px 24px",
      background: "var(--paper)",
      textAlign: "center",
    }}>
      <p style={{
        margin: "0 0 8px",
        fontFamily: 'Georgia, "Noto Serif SC", serif',
        fontSize: "clamp(56px, 10vw, 96px)",
        fontWeight: 400,
        color: "var(--line)",
        lineHeight: 1,
        letterSpacing: "-.03em",
        userSelect: "none",
      }}>
        404
      </p>
      <h1 style={{
        margin: "0 0 10px",
        fontSize: "clamp(18px, 3vw, 22px)",
        fontWeight: 700,
        color: "var(--ink)",
        letterSpacing: "-.01em",
      }}>
        页面不存在
      </h1>
      <p style={{
        margin: "0 0 32px",
        fontSize: 14,
        color: "var(--muted)",
        maxWidth: 320,
        lineHeight: 1.6,
      }}>
        你想访问的页面已被删除，或者链接已失效。
      </p>
      <Link
        href="/"
        style={{
          display: "inline-block",
          padding: "9px 22px",
          borderRadius: 9,
          background: "var(--ink)",
          color: "#fff",
          fontSize: 13,
          fontWeight: 700,
          textDecoration: "none",
        }}
      >
        返回首页
      </Link>
    </div>
  );
}
