"use client";

import clsx from "clsx";
import { envKind, ENV_META } from "@/lib/env";

/** Small 3-state environment pill (演示 / 沙盒 / 正式). Use on every screen header. */
export function EnvBadge({
  dryRun,
  sandbox,
  className,
}: {
  dryRun: boolean;
  sandbox: boolean;
  className?: string;
}) {
  const m = ENV_META[envKind(dryRun, sandbox)];
  return (
    <span
      title={m.note}
      className={clsx(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium",
        m.pill,
        className
      )}
    >
      <span className={clsx("h-1.5 w-1.5 rounded-full", m.dot)} />
      {m.label}
    </span>
  );
}

/** Full-width warning strip shown ONLY in the live store (rendered globally by AppShell). */
export function EnvBanner({ dryRun, sandbox }: { dryRun: boolean; sandbox: boolean }) {
  if (envKind(dryRun, sandbox) !== "live") return null;
  return (
    <div className="flex items-center justify-center gap-2 bg-rose-600 px-4 py-1.5 text-center text-xs font-medium text-white">
      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-white/90" />
      正式环境:你的所有操作都会作用于真实 Wildberries 店铺
    </div>
  );
}
