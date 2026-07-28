export default function AdminPlaceholder({
  eyebrow,
  title,
  description,
}: {
  eyebrow: string;
  title: string;
  description: string;
}) {
  return (
    <div style={{ padding: "28px clamp(18px, 3vw, 52px) 60px", minHeight: "100vh", background: "var(--paper)" }}>
      <div style={{ marginBottom: 20 }}>
        <p style={{ fontSize: 10, fontWeight: 700, letterSpacing: ".1em", textTransform: "uppercase", color: "var(--stage)", marginBottom: 4 }}>
          Admin · {eyebrow}
        </p>
        <h1 style={{ fontSize: 20, fontWeight: 800, color: "var(--ink)", letterSpacing: "-.01em" }}>{title}</h1>
      </div>
      <div style={{
        background: "white",
        borderRadius: 12,
        border: "1px solid var(--line)",
        padding: "48px 32px",
        textAlign: "center",
        color: "var(--muted)",
      }}>
        <p style={{ fontSize: 13, marginBottom: 6 }}>{description}</p>
        <p style={{ fontSize: 11 }}>功能建设中</p>
      </div>
    </div>
  );
}
