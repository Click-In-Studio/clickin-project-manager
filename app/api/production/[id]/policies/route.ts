/**
 * 策略配置中心的读写接口（#236 基建）。
 *
 * 门：**整个配置中心一个治理面门**，键表内零 SENSITIVE（§5.4）。
 * SENSITIVE 是给「权限的权限」用的（授权面 / 角色权限集 / owner 转让），判据是
 * 「这个键改的是不是权限系统本身」，不是「后果严不严重」——一旦让后果当判据，
 * 删除权、is_public 都能论证进去，档次当场膨胀。策略键按定义都是产品能力开关
 * （share_token_enabled 与「项目全局水印」同类），故统一走 production 的 config 段。
 * 保护手段是治理面门 ＋ 改动审计 ＋ 出口类开关的显式确认文案，不是审批流。
 */
import { type NextRequest } from "next/server";
import { requireGrantGate } from "@/lib/api-guard";
import { listPolicies, setPolicies, listPolicyAudit } from "@/lib/policy-db";
import { POLICY_QUESTIONS, matchAnswer, QUESTION_COVERED_KEYS } from "@/lib/policy-questions";

type Ctx = { params: Promise<{ id: string }> };

/** GET — 全部策略键的当前值 + 元信息；?audit=1 附带最近的改动记录。 */
export async function GET(req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const { deny } = await requireGrantGate(req, id, [
    ["production", "config", "view"],
    ["production", "config", "edit"],
  ]);
  if (deny) return deny;

  const policies = await listPolicies(id);

  // 语义层：同一份数据的另一个视图（§6.4 纪律 1，不是两张表）。
  // answerId=null ⇒ 第四态「自定义」——高级模式手改后组合可能不对应任何预设答案，
  // **不许静默显示最接近的那个**，否则人会以为自己在 A、实际在 A′。
  const current = new Map(policies.map((p) => [p.key, p.value]));
  const questions = POLICY_QUESTIONS.map((q) => ({
    id: q.id, group: q.group, title: q.title, help: q.help ?? null,
    danger: q.danger ?? false,
    answers: q.answers.map((a) => ({
      id: a.id, label: a.label, values: a.values, disposition: a.disposition,
    })),
    answerId: matchAnswer(q, current)?.id ?? null,
  }));
  // 高级模式专属：未被任何题覆盖的键
  const advancedOnly = policies.filter((p) => !QUESTION_COVERED_KEYS.has(p.key)).map((p) => p.key);

  const body = { policies, questions, advancedOnly };
  if (req.nextUrl.searchParams.get("audit") !== "1") return Response.json(body);
  return Response.json({ ...body, audit: await listPolicyAudit(id) });
}

/**
 * PUT — 批量改。Body: { changes: { [key]: value } }
 *
 * 整体事务：一道语义题往往同时设多个键（§6.4 纪律 3「选中预设答案 = 覆盖该问题涉及的
 * 全部键」），半截生效会配出自相矛盾的组合。
 */
export async function PUT(req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const { deny, session } = await requireGrantGate(
    req, id, [["production", "config", "edit"]], { blockArchived: true },
  );
  if (deny) return deny;

  const body = (await req.json().catch(() => null)) as { changes?: Record<string, string> } | null;
  const changes = body?.changes;
  if (!changes || typeof changes !== "object" || Array.isArray(changes)) {
    return Response.json({ error: "缺少 changes 对象" }, { status: 400 });
  }
  for (const v of Object.values(changes)) {
    if (typeof v !== "string") return Response.json({ error: "策略值必须是字符串" }, { status: 400 });
  }

  const res = await setPolicies(id, changes, session!.userId);
  if (!res.ok) return Response.json({ error: res.error }, { status: 400 });
  return Response.json({ ok: true, changed: res.changed });
}
