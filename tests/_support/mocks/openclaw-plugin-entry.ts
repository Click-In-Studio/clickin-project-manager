// openclaw/plugin-sdk/plugin-entry 的测试替身（vitest alias 注入）：
// definePluginEntry 在真实 SDK 里也只是身份包装，测试里原样返回定义，
// 让 tests 可以拿到 register() 并用 fake api 捕获 hook/middleware。
export function definePluginEntry<T>(definition: T): T {
  return definition;
}
