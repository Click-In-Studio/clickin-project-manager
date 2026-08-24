// Transactional email HTML builders.
// All styles are inline for maximum email-client compatibility.

const INK    = "#182a2a";
const SCRIPT = "#2f6670";
const MUTED  = "#667676";
const BG     = "#f4f5f3";
const CARD   = "#ffffff";
const LINE   = "#dde3e1";

function base(bodyHtml: string): string {
  return `<!DOCTYPE html>
<html lang="zh">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>后台</title></head>
<body style="margin:0;padding:0;background:${BG};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:${BG}">
<tr><td align="center" style="padding:40px 16px">
  <table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:${CARD};border-radius:12px;border:1px solid ${LINE};overflow:hidden">
    <!-- brand header -->
    <tr><td style="padding:20px 28px;border-bottom:1px solid ${LINE}">
      <span style="font-size:11px;font-weight:700;letter-spacing:.14em;color:${INK}">CLICK-IN</span>
      <span style="margin-left:10px;padding-left:10px;border-left:1px solid ${LINE};font-size:11px;color:${MUTED}">后台通知</span>
    </td></tr>
    <!-- body -->
    <tr><td style="padding:28px">${bodyHtml}</td></tr>
    <!-- footer -->
    <tr><td style="padding:16px 28px;border-top:1px solid ${LINE};background:#f9faf9">
      <p style="margin:0;font-size:10px;color:${MUTED}">你收到此邮件是因为你的账号已与「后台」绑定。请勿转发此邮件中的任何链接。</p>
    </td></tr>
  </table>
</td></tr>
</table>
</body></html>`;
}

function btn(label: string, url: string, style: "primary" | "secondary" | "danger" = "primary"): string {
  const bg   = style === "primary" ? INK : style === "danger" ? "#c53030" : "#eef0ed";
  const fg   = style === "secondary" ? INK : "#fff";
  const border = style === "secondary" ? `border:1px solid ${LINE};` : "";
  return `<a href="${url}" style="display:inline-block;padding:10px 20px;font-size:13px;font-weight:700;color:${fg};background:${bg};${border}border-radius:8px;text-decoration:none">${label}</a>`;
}

function divider(): string {
  return `<div style="height:1px;background:${LINE};margin:20px 0"></div>`;
}

function label(text: string): string {
  return `<p style="margin:0 0 4px;font-size:10px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:${SCRIPT}">${text}</p>`;
}

function smartTextToHtml(text: string): string {
  let s = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  // [#label](href) script refs → code-style label
  s = s.replace(/\[#([^\]]+)\]\([^)]*\)/g, (_, lbl) =>
    `<code style="font-size:11px;color:${SCRIPT}">#${lbl}</code>`);
  // [#kind:id] DB-format content mentions → strip
  s = s.replace(/\[#[^\]]+\]/g, "");
  s = s.replace(/\n/g, "<br>");
  return s;
}

// ── Generic notification email ─────────────────────────────────────────────────

export function buildNotificationEmail(params: {
  title: string;
  body: string;
  ctaLabel?: string;
  ctaUrl?: string;
}): string {
  const { title, body, ctaLabel, ctaUrl } = params;
  const bodyHtml = `
    <h1 style="margin:0 0 12px;font-size:20px;font-weight:700;color:${INK};line-height:1.3">${title}</h1>
    <p style="margin:0 0 20px;font-size:14px;color:${MUTED};line-height:1.6">${body}</p>
    ${ctaLabel && ctaUrl ? btn(ctaLabel, ctaUrl) : ""}
  `;
  return base(bodyHtml);
}

// ── Event publish — RSVP ──────────────────────────────────────────────────────

export function buildEventPublishEmail(params: {
  eventTitle: string;
  eventDescription?: string | null;
  callTimeStr: string;
  callTimeNotes?: string | null;
  viewUrl: string;
  rsvpUrls?: { yes: string; no: string; tentative: string };
  confirmUrl?: string;
}): string {
  const { eventTitle, eventDescription, callTimeStr, callTimeNotes, viewUrl, rsvpUrls, confirmUrl } = params;

  const rsvpSection = confirmUrl
    ? `${divider()}
       <p style="margin:0 0 12px;font-size:13px;color:${MUTED}">请确认你的出席状态：</p>
       ${btn("确认出席", confirmUrl, "primary")}`
    : rsvpUrls
      ? `${divider()}
         <p style="margin:0 0 12px;font-size:13px;color:${MUTED}">请告知你的出席状态：</p>
         <table cellpadding="0" cellspacing="0"><tr>
           <td style="padding-right:8px">${btn("是", rsvpUrls.yes, "primary")}</td>
           <td style="padding-right:8px">${btn("否", rsvpUrls.no, "secondary")}</td>
           <td>${btn("待定", rsvpUrls.tentative, "secondary")}</td>
         </tr></table>`
      : "";

  const descHtml = eventDescription?.trim()
    ? `<p style="margin:0 0 20px;font-size:13px;color:${MUTED};line-height:1.6">${smartTextToHtml(eventDescription.trim())}</p>`
    : "";

  const notesHtml = callTimeNotes?.trim()
    ? `<p style="margin:4px 0 0;font-size:12px;color:${MUTED};line-height:1.5">${smartTextToHtml(callTimeNotes.trim())}</p>`
    : "";

  const bodyHtml = `
    ${label("EVENT 已发布")}
    <h1 style="margin:0 0 8px;font-size:22px;font-weight:700;color:${INK};line-height:1.3">${eventTitle}</h1>
    ${descHtml}
    <table cellpadding="0" cellspacing="0" style="background:${BG};border-radius:8px;padding:14px 16px;margin-bottom:20px">
      <tr><td>
        <p style="margin:0 0 4px;font-size:10px;font-weight:700;color:${MUTED};letter-spacing:.06em;text-transform:uppercase">你的 Call 时间</p>
        <p style="margin:0;font-size:18px;font-weight:700;color:${INK}">${callTimeStr}</p>
        ${notesHtml}
      </td></tr>
    </table>
    ${rsvpSection}
    ${divider()}
    ${btn("查看 Event 详情", viewUrl, "secondary")}
  `;
  return base(bodyHtml);
}

// ── Weekly call ───────────────────────────────────────────────────────────────

export type WeeklyCallEmailEntry = {
  callAt: string;
  callNotes: string;
  eventTitle: string;
  eventLocation: string;
  scheduleItems: { title: string; startTime: string | null }[];
};

export function buildWeeklyCallEmail(entries: WeeklyCallEmailEntry[], viewUrl: string): string {
  const rows = entries.map(e => {
    const callTime = new Date(e.callAt).toLocaleString("zh-CN", {
      month: "numeric", day: "numeric",
      hour: "2-digit", minute: "2-digit",
      timeZone: "Asia/Shanghai",
    });
    const schedStr = e.scheduleItems.length
      ? e.scheduleItems.map(s => s.title).slice(0, 3).join("、") + (e.scheduleItems.length > 3 ? "…" : "")
      : "";
    return `
      <tr><td style="padding:14px 0;border-top:1px solid ${LINE}">
        <p style="margin:0 0 4px;font-size:13px;font-weight:700;color:${INK}">${e.eventTitle}</p>
        <p style="margin:0 0 2px;font-size:12px;color:${SCRIPT}">Call：${callTime}${e.callNotes ? ` · ${e.callNotes}` : ""}</p>
        ${e.eventLocation ? `<p style="margin:0 0 2px;font-size:11px;color:${MUTED}">地点：${e.eventLocation}</p>` : ""}
        ${schedStr ? `<p style="margin:0;font-size:11px;color:${MUTED}">日程：${schedStr}</p>` : ""}
      </td></tr>
    `;
  }).join("");

  const bodyHtml = `
    ${label("本周 CALL 安排")}
    <h1 style="margin:0 0 6px;font-size:22px;font-weight:700;color:${INK}">本周有 ${entries.length} 个安排</h1>
    <p style="margin:0 0 20px;font-size:13px;color:${MUTED}">以下是你本周的所有 Call 时间，详情请点击按钮查看。</p>
    <table width="100%" cellpadding="0" cellspacing="0">${rows}</table>
    ${divider()}
    ${btn("查看完整安排", viewUrl, "secondary")}
  `;
  return base(bodyHtml);
}

// ── Daily call ────────────────────────────────────────────────────────────────

export type DailyCallEmailScheduleItem = {
  title: string;
  startTime: string | null;
  participants: string[];
};

export function buildDailyCallEmail(params: {
  eventTitle: string;
  eventLocation: string;
  startTime: string;
  myCallAt: string;
  myCallNotes: string;
  scheduleItems: DailyCallEmailScheduleItem[];
  allCalls: { name: string; callAt: string }[];
  viewUrl: string;
  confirmUrl: string;
}): string {
  const { eventTitle, eventLocation, startTime, myCallAt, myCallNotes, scheduleItems, allCalls, viewUrl, confirmUrl } = params;

  const callTimeStr = new Date(myCallAt).toLocaleTimeString("zh-CN", {
    hour: "2-digit", minute: "2-digit", timeZone: "Asia/Shanghai",
  });
  const startTimeStr = new Date(startTime).toLocaleString("zh-CN", {
    month: "numeric", day: "numeric",
    hour: "2-digit", minute: "2-digit",
    timeZone: "Asia/Shanghai",
  });

  const schedRows = scheduleItems.map(item => {
    const time = item.startTime
      ? new Date(item.startTime).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Shanghai" })
      : "";
    const parts = item.participants.slice(0, 4).join("、") + (item.participants.length > 4 ? "…" : "");
    return `<tr>
      <td style="padding:8px 0;border-top:1px solid ${LINE};font-size:11px;color:${MUTED};white-space:nowrap;padding-right:12px">${time}</td>
      <td style="padding:8px 0;border-top:1px solid ${LINE};font-size:11px;color:${INK}">${item.title}${parts ? ` <span style="color:${MUTED}">· ${parts}</span>` : ""}</td>
    </tr>`;
  }).join("");

  const callsRows = allCalls.slice(0, 10).map(c => {
    const t = new Date(c.callAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Shanghai" });
    return `<tr>
      <td style="padding:4px 0;font-size:11px;color:${MUTED};padding-right:16px">${t}</td>
      <td style="padding:4px 0;font-size:11px;color:${INK}">${c.name}</td>
    </tr>`;
  }).join("");

  const bodyHtml = `
    ${label("明日 CALL SHEET")}
    <h1 style="margin:0 0 4px;font-size:22px;font-weight:700;color:${INK}">${eventTitle}</h1>
    <p style="margin:0 0 16px;font-size:13px;color:${MUTED}">${startTimeStr}${eventLocation ? ` · ${eventLocation}` : ""}</p>

    <table cellpadding="0" cellspacing="0" style="background:${BG};border-radius:8px;padding:14px 16px;margin-bottom:20px;width:100%">
      <tr><td>
        <p style="margin:0 0 4px;font-size:10px;font-weight:700;color:${MUTED};letter-spacing:.06em;text-transform:uppercase">你的 Call 时间</p>
        <p style="margin:0;font-size:20px;font-weight:700;color:${INK}">${callTimeStr}${myCallNotes ? ` <span style="font-size:12px;font-weight:400;color:${MUTED}">· ${myCallNotes}</span>` : ""}</p>
      </td></tr>
    </table>

    ${btn("确认出席", confirmUrl, "primary")}

    ${scheduleItems.length ? `${divider()}
    <p style="margin:0 0 10px;font-size:12px;font-weight:700;color:${INK}">排练日程</p>
    <table width="100%" cellpadding="0" cellspacing="0">${schedRows}</table>` : ""}

    ${allCalls.length > 1 ? `${divider()}
    <p style="margin:0 0 10px;font-size:12px;font-weight:700;color:${INK}">全员 Call 时间</p>
    <table cellpadding="0" cellspacing="0">${callsRows}${allCalls.length > 10 ? `<tr><td colspan="2" style="padding:4px 0;font-size:11px;color:${MUTED}">…还有 ${allCalls.length - 10} 人</td></tr>` : ""}</table>` : ""}

    ${divider()}
    ${btn("查看完整 Call Sheet", viewUrl, "secondary")}
  `;
  return base(bodyHtml);
}

// ── Report notification ───────────────────────────────────────────────────────

// 正文/备注由 lib/notify-doc/platform-html 预渲染成 HTML（已转义、已在 AST 层
// 截断）。本模板**不再自己剥标签也不再自己切字**：
//   · `.replace(/<[^>]*>/g,"")` 是"看起来像消毒"的写法——剥不掉实体、挡不住 &，
//     而且会吃掉正文里以 < 开头的合法文本
//   · 按字符数切渲染结果会把 <a href="…"> 拦腰截断，直接毁掉 HTML
export function buildReportEmail(params: {
  reportTitle: string;
  eventTitle: string;
  reportBodyHtml: string;
  notes: { deptName: string; contentHtml: string }[];
  viewUrl: string;
}): string {
  const { reportTitle, eventTitle, reportBodyHtml, notes, viewUrl } = params;

  const noteRows = notes.slice(0, 5).map(n =>
    `<tr>
       <td style="padding:10px 0;border-top:1px solid ${LINE};font-size:11px;font-weight:700;color:${SCRIPT};white-space:nowrap;padding-right:16px;vertical-align:top">${n.deptName}</td>
       <td style="padding:10px 0;border-top:1px solid ${LINE};font-size:11px;color:${MUTED};line-height:1.5">${n.contentHtml}</td>
     </tr>`,
  ).join("");

  const bodyHtml = `
    ${label("新报告")}
    <h1 style="margin:0 0 4px;font-size:22px;font-weight:700;color:${INK}">${reportTitle}</h1>
    <p style="margin:0 0 16px;font-size:13px;color:${MUTED}">${eventTitle}</p>
    ${reportBodyHtml ? `<div style="margin:0 0 20px">${reportBodyHtml}</div>` : ""}
    ${noteRows ? `<table width="100%" cellpadding="0" cellspacing="0">${noteRows}</table>${divider()}` : ""}
    ${btn("查看完整报告", viewUrl)}
  `;
  return base(bodyHtml);
}

// ── Mention notification ──────────────────────────────────────────────────────

export function buildMentionEmail(params: {
  reportTitle: string;
  eventTitle: string;
  viewUrl: string;
}): string {
  const { reportTitle, eventTitle, viewUrl } = params;
  return buildNotificationEmail({
    title: `${eventTitle} 的报告中提到了你`,
    body: `报告「${reportTitle}」中提及了你，点击查看完整内容。`,
    ctaLabel: "查看报告",
    ctaUrl: viewUrl,
  });
}
