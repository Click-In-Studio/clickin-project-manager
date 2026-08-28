// 本地补丁 #1（见 vendor/openclaw/VENDOR.md）：
// 上游 monorepo 里 @openclaw/ai 重导出 @openclaw/llm-core，EventStream 全库只有
// 一个类声明。我们 vendor 了 llm-core 源码、又从 npm 装了已打包的 @openclaw/ai
// （内含同一份 llm-core），于是出现两个 EventStream 类：agent-loop.ts 刻意从
// "@openclaw/ai/event-stream" 取运行时构造器以共享身份，与本文件的本地声明
// 在类型上互不兼容（private 成员分属两份声明）。这里改成纯重导出，让运行时
// 类与类型声明都只剩 npm 包那一份。原实现见上游同路径文件。
export {
  EventStream,
  AssistantMessageEventStream,
  createAssistantMessageEventStream,
} from "@openclaw/ai/event-stream";
