// MMP（multimodal-pipeline）调用节点：自建的多模态感知服务（#454 分工：①管线工具 +
// ②入话分诊由它承接，③VLM subagent 在 agent 侧）。本模块只负责「拿到一个配置好的
// 客户端」——协议、媒体句柄、注入模板都在 `@mmp/client` 包里，这里不重复封装。
//
// 只在服务端用（持 api key）：客户端组件不得 import lib/mmp/*。
// 未配置（缺 MMP_BASE_URL）= 服务不存在，调用方按「不可用」诚实标注，不是报错。

import { MmpClient } from "@mmp/client";

let cached: { key: string; client: MmpClient } | null = null;

export function isMmpConfigured(): boolean {
  return Boolean(process.env.MMP_BASE_URL);
}

/** 按当前 env 取客户端；env 变了（测试）就重建。未配置返回 null。 */
export function getMmpClient(): MmpClient | null {
  const baseUrl = process.env.MMP_BASE_URL;
  if (!baseUrl) return null;
  const apiKey = process.env.MMP_API_KEY;
  const key = `${baseUrl}\n${apiKey ?? ""}`;
  if (cached?.key !== key) cached = { key, client: new MmpClient({ baseUrl, apiKey }) };
  return cached.client;
}
