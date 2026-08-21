import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getPool } from "@/lib/pg";
import { upsertFeishuUser } from "@/lib/db";
import {
  buildInstructionsBlock,
  getAgentInstructions,
  setAgentInstructions,
} from "@/lib/agent-instructions";
import { buildInjectContext } from "@/lib/agent-memory/inject";
import { shortId } from "./factories";

// agents.md 分级指令：存取 + 注入组装（顺序/降级/截断/成员门）+
// buildInjectContext 双字段拆分（instructions 须遵守 / memory 仅参考）。

let userId: string;
const prodId = shortId();

beforeAll(async () => {
  ({ userId } = await upsertFeishuUser(`test-open-${shortId()}`, `指令测试用户-${shortId()}`, null, false));
});

afterAll(async () => {
  await getPool().query(`DELETE FROM agent_instructions WHERE scope_id IN ($1, $2)`, [userId, prodId]);
});

describe("agent instructions store", () => {
  it("set/get roundtrip per scope; empty content reads as null", async () => {
    await setAgentInstructions("user", userId, "回复保持简短。", userId);
    await setAgentInstructions("production", prodId, "术语用剧本原文写法。", userId);
    expect(await getAgentInstructions("user", userId)).toBe("回复保持简短。");
    expect(await getAgentInstructions("production", prodId)).toBe("术语用剧本原文写法。");

    await setAgentInstructions("user", userId, "   ", userId);
    expect(await getAgentInstructions("user", userId)).toBeNull();
  });

  it("upsert overwrites in place (single row per scope)", async () => {
    await setAgentInstructions("user", userId, "v1", userId);
    await setAgentInstructions("user", userId, "v2", userId);
    expect(await getAgentInstructions("user", userId)).toBe("v2");
    const { rows } = await getPool().query(
      `SELECT count(*)::int AS n FROM agent_instructions WHERE scope_type = 'user' AND scope_id = $1`,
      [userId],
    );
    expect(rows[0].n).toBe(1);
  });
});

describe("buildInstructionsBlock", () => {
  it("orders production before user, wide to narrow", async () => {
    await setAgentInstructions("user", userId, "个人内容", userId);
    await setAgentInstructions("production", prodId, "制作内容", userId);
    const block = await buildInstructionsBlock(userId, prodId, true);
    expect(block).toContain("### 本制作的指令\n制作内容");
    expect(block).toContain("### 用户的个人指令\n个人内容");
    expect(block!.indexOf("本制作的指令")).toBeLessThan(block!.indexOf("用户的个人指令"));
  });

  it("production section is gated on membership signal (includeProduction=false)", async () => {
    // 非成员会话不注入制作级指令——门与「当前制作」段同一信号
    const block = await buildInstructionsBlock(userId, prodId, false);
    expect(block).toContain("个人内容");
    expect(block).not.toContain("制作内容");
  });

  it("demotes internal headings below the section level", async () => {
    await setAgentInstructions("user", userId, "# 大标题\n## 二级\n### 三级\n正文", userId);
    const block = await buildInstructionsBlock(userId, null, false);
    // 内容自带的 #/##/### 都不得与 ### 段标题同级或更高
    expect(block).toContain("#### 大标题");
    expect(block).toContain("#### 二级");
    expect(block).toContain("#### 三级");
  });

  it("clips over-budget content with a truncation marker", async () => {
    await setAgentInstructions("user", userId, "长".repeat(3000), userId);
    const block = await buildInstructionsBlock(userId, null, false);
    expect(block!.length).toBeLessThan(2200);
    expect(block).toContain("（指令过长已截断）");
  });

  it("returns null when no instructions exist at all", async () => {
    const { userId: fresh } = await upsertFeishuUser(`test-open-${shortId()}`, `无指令-${shortId()}`, null, false);
    expect(await buildInstructionsBlock(fresh, null, false)).toBeNull();
  });
});

describe("buildInjectContext split payload", () => {
  it("returns instructions and memory as separate fields", async () => {
    await setAgentInstructions("user", userId, "个人指令内容", userId);
    const payload = await buildInjectContext(userId);
    // memory 恒有（至少含界面上下文规则段），指令进独立字段不混入
    expect(payload.memory).toContain("界面上下文说明");
    expect(payload.memory).not.toContain("个人指令内容");
    expect(payload.instructions).toContain("个人指令内容");
  });

  it("instructions is null for a user with none — memory still present", async () => {
    const { userId: fresh } = await upsertFeishuUser(`test-open-${shortId()}`, `无指令2-${shortId()}`, null, false);
    const payload = await buildInjectContext(fresh);
    expect(payload.instructions).toBeNull();
    expect(payload.memory).toContain("界面上下文说明");
  });
});
