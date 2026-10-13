/** 客户端与运行器共用的模型选择；厂商凭据只存在服务端。 */
export type ModelKey =
  | "deepseek-flash"
  | "deepseek-pro"
  | "resonance"
  | "inspiration";
export type ThinkingLevel = "off" | "low" | "medium" | "high" | "max";
export interface ModelSelection {
  modelKey: ModelKey;
  thinkingLevel: ThinkingLevel;
  disabledSubagentModels: ModelKey[];
}
export interface AgentModelInfo {
  key: ModelKey;
  name: string;
  description: string;
  costTier: "low" | "medium" | "high";
  input: Array<"text" | "image" | "file" | "audio" | "video">;
  thinkingLevels: ThinkingLevel[];
  available: boolean;
  unavailableReason: string | null;
}
export const DEFAULT_MODEL_SELECTION: ModelSelection = {
  modelKey: "deepseek-flash",
  thinkingLevel: "low",
  disabledSubagentModels: [],
};
