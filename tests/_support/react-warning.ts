/** 只收集 React 的确定性错误警告；业务失败日志不属于这条护栏。 */
export function createReactWarningCollector() {
  const warnings: string[] = [];
  return {
    record(args: unknown[]) {
      const message = args.map(String).join(" ");
      if (/Each child in a list should have a unique ["']key["'] prop|Encountered two children with the same key|A component is changing an? (?:uncontrolled|controlled) input to be (?:controlled|uncontrolled)|Cannot update a component .* while rendering a different component/.test(message)) {
        warnings.push(message);
      }
    },
    check() {
      if (warnings.length) throw new Error(`React 错误警告：\n${warnings.join("\n")}`);
    },
  };
}
