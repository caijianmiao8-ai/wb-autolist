// Single source of truth for the 3-state environment, shared by every screen so
// the "which store am I touching" answer is identical app-wide.
//   demo    — no WB token (dry-run): nothing is published.
//   sandbox — WB sandbox store: safe to test, not the real shop.
//   live    — the real Wildberries store: every action is real + irreversible.
// Class strings are full literals so Tailwind's content scan keeps them.

export type EnvKind = "demo" | "sandbox" | "live";

export function envKind(dryRun: boolean, sandbox: boolean): EnvKind {
  if (dryRun) return "demo";
  return sandbox ? "sandbox" : "live";
}

export const ENV_META: Record<EnvKind, { label: string; note: string; dot: string; pill: string }> = {
  demo: {
    label: "演示",
    note: "演示模式 · 不会真实上架",
    dot: "bg-slate-400",
    pill: "border-slate-400/40 bg-slate-500/10 text-slate-600 dark:text-slate-300",
  },
  sandbox: {
    label: "沙盒",
    note: "沙盒测试 · 不影响真实店铺",
    dot: "bg-amber-500",
    pill: "border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-300",
  },
  live: {
    label: "正式",
    note: "正式店铺 · 操作作用于真实店铺",
    dot: "bg-rose-500",
    pill: "border-rose-500/40 bg-rose-500/10 text-rose-600 dark:text-rose-300",
  },
};
