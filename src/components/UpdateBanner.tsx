"use client";

import { useEffect, useState } from "react";
import { Download, Loader2, X, Sparkles } from "lucide-react";
import { checkForUpdate, runUpdate, type UpdateInfo } from "@/lib/updater";

// Auto-checks for a new release on launch (GitHub `latest.json`). If one exists,
// shows a slim top banner offering a one-click download+install (then relaunch).
// No-ops silently outside the Tauri runtime / offline.
export function UpdateBanner() {
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [pct, setPct] = useState<number | null>(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    checkForUpdate().then(setInfo).catch(() => {});
  }, []);

  if (!info || dismissed) return null;

  async function doUpdate() {
    setErr("");
    setPct(0);
    try {
      await runUpdate(setPct); // relaunches the app on success
    } catch (e) {
      setErr(e instanceof Error ? e.message : "更新失败");
      setPct(null);
    }
  }

  return (
    <div className="flex items-center gap-2.5 border-b border-wb-pink/20 bg-wb-pink/[0.09] px-4 py-2 text-[12px] text-wb-pink sm:px-6">
      <Sparkles className="h-4 w-4 shrink-0" />
      <span className="min-w-0 flex-1 truncate">
        发现新版本 <b>v{info.version}</b>（当前 v{info.current}）
        {err && <span className="text-rose-600 dark:text-rose-400"> · {err}</span>}
      </span>
      {pct == null ? (
        <>
          <button
            type="button"
            onClick={doUpdate}
            className="flex shrink-0 items-center gap-1 rounded-md bg-wb-pink px-2.5 py-1 text-[11px] font-semibold text-white transition hover:brightness-105"
          >
            <Download className="h-3.5 w-3.5" /> 立即更新
          </button>
          <button
            type="button"
            onClick={() => setDismissed(true)}
            title="稍后"
            className="grid h-6 w-6 shrink-0 place-items-center rounded text-wb-pink/70 transition hover:bg-wb-pink/10 hover:text-wb-pink"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </>
      ) : (
        <span className="flex shrink-0 items-center gap-1.5 font-medium">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> 下载安装中 {pct}%…（完成后自动重启）
        </span>
      )}
    </div>
  );
}
