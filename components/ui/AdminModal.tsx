"use client";

// 管理后台通用轻量 modal：backdrop 点击关闭，卡片承载表单。
export default function AdminModal({
  kicker, title, onClose, children, width = 400,
}: {
  kicker?: string;
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  width?: number;
}) {
  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed", inset: 0, background: "rgba(24,42,42,.4)", zIndex: 90,
        display: "flex", alignItems: "center", justifyContent: "center",
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{ background: "var(--surface)", borderRadius: 13, padding: "24px 28px", width, maxWidth: "92vw" }}
      >
        {kicker && (
          <p style={{ margin: "0 0 4px", fontSize: 10, fontWeight: 700, letterSpacing: ".1em", textTransform: "uppercase", color: "var(--stage)" }}>
            {kicker}
          </p>
        )}
        <h3 style={{ margin: "0 0 16px", fontFamily: 'Georgia, "Noto Serif SC", serif', fontSize: 19, fontWeight: 500, color: "var(--ink)" }}>
          {title}
        </h3>
        {children}
      </div>
    </div>
  );
}
