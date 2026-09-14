export const LIST_COLORS = [
  { bg: "bg-blue-500",    text: "text-blue-600",    line: "#3b82f6", light: "bg-blue-50"    },
  { bg: "bg-amber-500",   text: "text-amber-600",   line: "#f59e0b", light: "bg-amber-50"   },
  { bg: "bg-emerald-500", text: "text-emerald-600", line: "#10b981", light: "bg-emerald-50" },
  { bg: "bg-violet-500",  text: "text-violet-600",  line: "#8b5cf6", light: "bg-violet-50"  },
  { bg: "bg-rose-500",    text: "text-rose-600",    line: "#f43f5e", light: "bg-rose-50"    },
  { bg: "bg-cyan-500",    text: "text-cyan-600",    line: "#06b6d4", light: "bg-cyan-50"    },
];
export function colorFor(idx: number) { return LIST_COLORS[idx % LIST_COLORS.length]; }
