import Link from "next/link";
import type { Metadata } from "next";
import { getProductionName } from "@/lib/db";
import { getTechReqByProduction } from "@/lib/event-db";
import UnauthorizedActions from "@/components/UnauthorizedActions";

export const metadata: Metadata = { title: "无访问权限" };

type Ctx = { searchParams: Promise<{ resource?: string; id?: string; taskId?: string }> };

// Maps atomic permission strings to human-readable descriptions
const PERMISSION_LABELS: Record<string, string> = {
  // 读权限
  "event:view": "查看日程列表",
  "event:view_call_sheet": "查看 Call Sheet",
  // 写权限
  "event:edit": "编辑日程",
  "event:edit_call": "编辑 Call 时间",
  "event:edit_schedule": "编辑日程安排",
  "event:assign_participants": "分配参与者",
  "event:delete_tech_req_any": "删除技术需求",
};

export default async function UnauthorizedPage({ searchParams }: Ctx) {
  const { resource, id, taskId } = await searchParams;

  const [productionName, taskReq] = await Promise.all([
    id ? getProductionName(id) : Promise.resolve(null),
    taskId && id ? getTechReqByProduction(taskId, id) : Promise.resolve(null),
  ]);

  const backHref = id ? `/production/${id}` : "/";
  const backLabel = productionName ? `返回《${productionName}》` : "返回首页";

  const permLabel = resource ? (PERMISSION_LABELS[resource] ?? resource) : null;

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
        {resource ? "权限不足" : "无访问权限"}
      </h1>
      <p style={{
        margin: "0 0 20px",
        fontSize: 14,
        color: "var(--muted)",
        maxWidth: 360,
        lineHeight: 1.6,
      }}>
        {resource
          ? "你没有访问这个功能所需的权限，请联系项目管理员申请授权。"
          : "你不是这个项目的成员，请联系项目管理员。"}
      </p>

      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8, marginBottom: 32 }}>
        {/* 项目上下文 */}
        {productionName && (
          <p style={{
            margin: 0,
            fontSize: 13,
            color: "var(--muted)",
            background: "var(--surface)",
            border: "1px solid var(--line)",
            borderRadius: 8,
            padding: "6px 16px",
            display: "inline-block",
          }}>
            项目：<b style={{ color: "var(--ink)" }}>《{productionName}》</b>
          </p>
        )}

        {/* 具体资源上下文（如技术需求） */}
        {taskReq && (
          <p style={{
            margin: 0,
            fontSize: 13,
            color: "var(--muted)",
            background: "var(--surface)",
            border: "1px solid var(--line)",
            borderRadius: 8,
            padding: "6px 16px",
            display: "inline-block",
          }}>
            技术需求：<b style={{ color: "var(--ink)" }}>{taskReq.title}</b>
          </p>
        )}

        {/* 所需原子权限 */}
        {permLabel && (
          <p style={{
            margin: 0,
            fontSize: 13,
            color: "var(--muted)",
            background: "var(--surface)",
            border: "1px solid var(--line)",
            borderRadius: 8,
            padding: "6px 16px",
            display: "inline-block",
          }}>
            所需权限：<b style={{ color: "var(--ink)" }}>{permLabel}</b>
            {resource && resource !== permLabel && (
              <span style={{ marginLeft: 6, fontFamily: "monospace", fontSize: 11, opacity: 0.5 }}>
                ({resource})
              </span>
            )}
          </p>
        )}
      </div>

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", justifyContent: "center" }}>
        {/* 申请权限 — opens AccessRequestModal pre-filled from the resource param */}
        {resource && id && (
          <UnauthorizedActions productionId={id} resource={resource} />
        )}
        <Link
          href={backHref}
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
          {backLabel}
        </Link>
      </div>

      <p style={{ marginTop: 20, fontSize: 12, color: "var(--muted)" }}>
        如有疑问，请联系项目管理员。
      </p>
    </div>
  );
}
