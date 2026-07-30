import Link from "next/link";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "无访问权限" };

type Ctx = { searchParams: Promise<{ resource?: string; id?: string }> };

export default async function UnauthorizedPage({ searchParams }: Ctx) {
  const { resource, id } = await searchParams;

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
        403
      </p>
      <h1 style={{
        margin: "0 0 10px",
        fontSize: "clamp(18px, 3vw, 22px)",
        fontWeight: 700,
        color: "var(--ink)",
        letterSpacing: "-.01em",
      }}>
        无访问权限
      </h1>
      <p style={{
        margin: "0 0 8px",
        fontSize: 14,
        color: "var(--muted)",
        maxWidth: 360,
        lineHeight: 1.6,
      }}>
        你没有访问这个页面的权限。
      </p>
      {resource && (
        <p style={{
          margin: "0 0 32px",
          fontSize: 13,
          color: "var(--muted)",
          background: "var(--surface)",
          border: "1px solid var(--line)",
          borderRadius: 8,
          padding: "6px 16px",
          display: "inline-block",
        }}>
          所需权限：<b style={{ color: "var(--ink)" }}>{resource}</b>
          {id && <span style={{ marginLeft: 6, opacity: 0.5 }}>({id})</span>}
        </p>
      )}
      {!resource && <div style={{ marginBottom: 32 }} />}

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", justifyContent: "center" }}>
        {/* Placeholder — wire up to approval flow when ready */}
        {resource && (
          <button
            disabled
            title="审批流功能即将上线"
            style={{
              padding: "9px 22px",
              borderRadius: 9,
              background: "var(--surface-2)",
              color: "var(--muted)",
              fontSize: 13,
              fontWeight: 700,
              border: "1px solid var(--line)",
              cursor: "not-allowed",
            }}
          >
            申请权限
          </button>
        )}
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

      <p style={{ marginTop: 20, fontSize: 12, color: "var(--muted)" }}>
        如有疑问，请联系项目管理员。
      </p>
    </div>
  );
}
