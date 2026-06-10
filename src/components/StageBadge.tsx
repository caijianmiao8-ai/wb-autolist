import clsx from "clsx";
import type { ListingStage } from "@/lib/types";

const MAP: Record<ListingStage, { label: string; cls: string }> = {
  draft: { label: "草稿", cls: "bg-slate-500/20 text-slate-300 border-slate-400/30" },
  queued: { label: "排队中", cls: "bg-amber-500/15 text-amber-300 border-amber-400/30" },
  creating: { label: "建卡中", cls: "bg-amber-500/15 text-amber-300 border-amber-400/30" },
  media: { label: "上传图片", cls: "bg-sky-500/15 text-sky-300 border-sky-400/30" },
  pricing: { label: "定价中", cls: "bg-sky-500/15 text-sky-300 border-sky-400/30" },
  live: { label: "已上架", cls: "bg-emerald-500/15 text-emerald-300 border-emerald-400/30" },
  error: { label: "失败", cls: "bg-rose-500/15 text-rose-300 border-rose-400/30" },
};

export function StageBadge({ stage }: { stage: ListingStage }) {
  const m = MAP[stage] ?? MAP.draft;
  return (
    <span
      className={clsx(
        "inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium",
        m.cls
      )}
    >
      {m.label}
    </span>
  );
}
