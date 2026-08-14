import PageHeader from "@/components/PageHeader";

// 管理后台占位页（v3 统一风格）：eyebrow=项目名，group 显示于空态 kicker。
export default function AdminPlaceholder({
  productionName,
  group,
  title,
  description,
}: {
  productionName: string;
  group: string;
  title: string;
  description: string;
}) {
  return (
    <div style={{ padding: "24px clamp(18px, 3vw, 52px) 60px", minHeight: "100vh", background: "var(--paper)" }}>
      <PageHeader eyebrow={productionName} title={title} side="stage" />
      <section style={{
        background: "var(--surface)", border: "1px solid var(--line)", borderRadius: 13,
        padding: "56px 32px", textAlign: "center",
        height: "calc(100vh - 320px)", minHeight: 460,
        display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 6,
      }}>
        <p style={{ margin: 0, fontSize: 10, fontWeight: 700, letterSpacing: ".1em", textTransform: "uppercase", color: "var(--stage)" }}>
          {group} · Coming Soon
        </p>
        <p style={{ margin: 0, fontFamily: 'Georgia, "Noto Serif SC", serif', fontSize: 19, fontWeight: 500, color: "var(--ink)" }}>
          功能建设中
        </p>
        <p style={{ margin: 0, fontSize: 13, color: "var(--muted)" }}>{description}</p>
      </section>
    </div>
  );
}
