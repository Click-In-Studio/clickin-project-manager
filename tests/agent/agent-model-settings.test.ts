import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "@/app/api/agent/models/route";
import { PATCH } from "@/app/api/agent/sessions/[key]/route";
import { getPool } from "@/lib/pg";
import { upsertFeishuUser } from "@/lib/account/db-feishu";
import {
  makeProduction,
  setProductionTier,
  cleanupProduction,
  shortId,
} from "../_support/factories";
import { addProductionMember } from "@/lib/perm/member-db";
import { createSession, SESSION_COOKIE } from "@/lib/account/session";
import { createNewSessionKey } from "@/lib/agent/tools/session-identity";
import {
  modelCatalog,
  sessionModelSelection,
} from "@/lib/agent/runtime/model-settings-db";
let owner: string;
let member: string;
let outsider: string;
let prodId: string;
beforeAll(async () => {
  owner = (
    await upsertFeishuUser(
      `models-owner-${shortId()}`,
      "模型所有者",
      null,
      false,
    )
  ).userId;
  member = (
    await upsertFeishuUser(
      `models-member-${shortId()}`,
      "模型成员",
      null,
      false,
    )
  ).userId;
  outsider = (
    await upsertFeishuUser(
      `models-outsider-${shortId()}`,
      "非成员",
      null,
      false,
    )
  ).userId;
  ({ prodId } = await makeProduction(owner));
  await setProductionTier(prodId, "pro");
  await addProductionMember(prodId, member);
  for (const key of ["DEEPSEEK_API_KEY", "EMBEDDING_API_KEY", "GEMINI_API_KEY"])
    vi.stubEnv(key, "test");
});
afterAll(async () => {
  await cleanupProduction(prodId).catch(() => {});
  vi.unstubAllEnvs();
});
function request(userId: string | null, key: string, body?: unknown) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (userId)
    headers.Cookie = `${SESSION_COOKIE}=${createSession({ userId, name: "测试", avatarUrl: null, isAdmin: false })}`;
  return new NextRequest(
    `http://localhost/api/agent/models?sessionKey=${encodeURIComponent(key)}`,
    {
      headers,
      ...(body ? { method: "PATCH", body: JSON.stringify(body) } : {}),
    },
  );
}
describe("模型资格与会话设置", () => {
  it("401、非成员403；只持个人档资格或单枚业务授权不能访问项目目录", async () => {
    expect(
      (await GET(request(null, createNewSessionKey(owner, prodId)))).status,
    ).toBe(401);
    await getPool().query(
      "INSERT INTO user_plan(user_id,tier,source) VALUES($1,'creator','test') ON CONFLICT(user_id) DO UPDATE SET tier='creator'",
      [outsider],
    );
    await getPool().query("INSERT INTO production_member_grant(production_id,user_id,resource_type,resource_id,resource_sub,permission_level,grant_source) VALUES($1,$2,'character','*','*','view','direct')", [prodId, outsider]);
    expect(
      (await GET(request(outsider, createNewSessionKey(outsider, prodId))))
        .status,
    ).toBe(403);
  });
  it("项目成员个人为普通档仍能使用项目模型，个人会话仅基线；free项目不开放", async () => {
    expect(
      (await modelCatalog(member, prodId)).every((item) => item.available),
    ).toBe(true);
    expect(
      (await modelCatalog(member, null))
        .filter((item) => item.available)
        .map((item) => item.key),
    ).toEqual(["deepseek-flash"]);
    await setProductionTier(prodId, "free");
    expect(
      (await modelCatalog(member, prodId)).every((item) => !item.available),
    ).toBe(true);
    await setProductionTier(prodId, "pro");
  });
  it("事务内资格与选择读取复用当前连接，不再向连接池借 SQL 连接", async () => {
    const client = await getPool().connect();
    const poolQuery = vi.spyOn(getPool(), "query").mockImplementation(() => { throw new Error("事务内重复借连接"); });
    try {
      expect((await modelCatalog(member, prodId, client)).every(item => item.available)).toBe(true);
      expect((await sessionModelSelection(createNewSessionKey(member, prodId), client)).modelKey).toBe("deepseek-flash");
    } finally { poolQuery.mockRestore(); client.release(); }
  });
  it("首次消息前保存、刷新恢复；错误模型与无资格选择明确失败", async () => {
    const key = createNewSessionKey(member, prodId);
    const selection = {
      modelKey: "resonance",
      thinkingLevel: "high",
      disabledSubagentModels: ["inspiration"],
    };
    expect(
      (
        await PATCH(request(member, key, { modelSelection: selection }), {
          params: Promise.resolve({ key }),
        })
      ).status,
    ).toBe(200);
    expect(await sessionModelSelection(key)).toEqual(selection);
    expect(
      (
        await PATCH(
          request(member, key, {
            modelSelection: { ...selection, modelKey: "unknown" },
          }),
          { params: Promise.resolve({ key }) },
        )
      ).status,
    ).toBe(400);
    const personal = createNewSessionKey(member);
    expect(
      (
        await PATCH(request(member, personal, { modelSelection: selection }), {
          params: Promise.resolve({ key: personal }),
        })
      ).status,
    ).toBe(403);
  });
});
