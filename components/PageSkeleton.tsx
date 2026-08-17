/**
 * 路由切换骨架屏 —— 各段 loading.tsx 的共用占位。
 *
 * 全部页面都是 dynamic server component（用了 cookies()），在没有 Suspense
 * 边界时 App Router 的导航是阻塞式的：点击后停在原页面、URL 不变、侧栏高亮
 * 不动，直到整页 RSC payload 算完传回才一次性切换。用户会以为没点上。
 *
 * 有了 loading.tsx（即这个骨架）之后：点击瞬间 URL 就变、侧栏高亮跟着走、
 * 内容区先出占位；顺带让 dynamic 路由的 <Link> prefetch 真正有东西可预取
 * （dynamic 路由只能预取到最近的 loading 边界）。
 *
 * 骨架本身用 .skeleton-page 的延迟淡入，服务端够快时不会闪一下。
 */

/** 行宽固定枚举而非随机，避免 hydration 前后不一致。 */
const ROWS: { title: number; hint: number; tail: number }[] = [
  { title: 168, hint: 96, tail: 62 },
  { title: 132, hint: 124, tail: 44 },
  { title: 196, hint: 88, tail: 70 },
  { title: 148, hint: 112, tail: 52 },
  { title: 176, hint: 78, tail: 58 },
  { title: 120, hint: 104, tail: 48 },
];

export default function PageSkeleton() {
  return (
    <div
      className="skeleton-page"
      style={{ padding: "24px clamp(18px, 3vw, 52px) 60px", minHeight: "100vh", background: "var(--paper)" }}
      role="status"
      aria-busy="true"
      aria-label="页面加载中"
    >
      {/* 页头占位：eyebrow + 大标题 + 场景动作区（对齐 PageHeader 语汇） */}
      <div style={{ display: "flex", alignItems: "flex-end", gap: 20, marginBottom: 22, flexWrap: "wrap" }}>
        <div style={{ minWidth: 0 }}>
          <div className="skeleton-bar" style={{ width: 68, height: 10, borderRadius: 4 }} />
          <div className="skeleton-bar" style={{ width: 208, height: 34, marginTop: 9, borderRadius: 8 }} />
        </div>
        <div style={{ marginLeft: "auto", display: "flex", gap: 8, flexShrink: 0 }}>
          <div className="skeleton-bar" style={{ width: 92, height: 38, borderRadius: 8 }} />
        </div>
      </div>

      {/* 内容占位：单张 surface 卡片 + 若干行 */}
      <div
        style={{
          background: "var(--surface)",
          border: "1px solid var(--line)",
          borderRadius: 14,
          padding: "2px 18px",
        }}
      >
        {ROWS.map((row, i) => (
          <div
            key={i}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 12,
              padding: "18px 0",
              borderTop: i === 0 ? 0 : "1px solid var(--line)",
            }}
          >
            <div className="skeleton-bar" style={{ width: 27, height: 27, borderRadius: 7, flexShrink: 0 }} />
            <div style={{ display: "flex", flexDirection: "column", gap: 7, minWidth: 0, flex: 1 }}>
              <div className="skeleton-bar" style={{ width: row.title, maxWidth: "100%", height: 12 }} />
              <div className="skeleton-bar" style={{ width: row.hint, maxWidth: "100%", height: 9, borderRadius: 4 }} />
            </div>
            <div className="skeleton-bar" style={{ width: row.tail, height: 20, borderRadius: 999, flexShrink: 0 }} />
          </div>
        ))}
      </div>
    </div>
  );
}
