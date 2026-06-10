"use client";

import { useEffect, useRef, useState } from "react";
import {
  Upload,
  Loader2,
  Plus,
  X,
  Rocket,
  Trash2,
  FileSpreadsheet,
  CheckCircle2,
  AlertTriangle,
  Clock,
} from "lucide-react";
import clsx from "clsx";
import type { ListingInput } from "@/lib/types";

interface Job {
  id: string;
  input: ListingInput;
  autoPublish: boolean;
  status: "pending" | "generating" | "publishing" | "done" | "error";
  nmID: number | null;
  sandbox: boolean;
  error: string | null;
}

const STATUS: Record<Job["status"], { label: string; cls: string; icon: typeof Clock }> = {
  pending: { label: "排队中", cls: "text-slate-400", icon: Clock },
  generating: { label: "生成中", cls: "text-amber-300", icon: Loader2 },
  publishing: { label: "上架中", cls: "text-sky-300", icon: Loader2 },
  done: { label: "完成", cls: "text-emerald-400", icon: CheckCircle2 },
  error: { label: "失败", cls: "text-rose-400", icon: AlertTriangle },
};

export function BatchPanel() {
  const [rows, setRows] = useState<ListingInput[]>([]);
  const [importing, setImporting] = useState(false);
  const [autoPublish, setAutoPublish] = useState(false);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [enqueuing, setEnqueuing] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // poll queue status while anything is in flight
  useEffect(() => {
    const load = async () => {
      const r = await fetch("/api/batch/jobs");
      if (r.ok) setJobs(await r.json());
    };
    load();
    pollRef.current = setInterval(load, 2500);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  const active = jobs.some((j) => j.status === "pending" || j.status === "generating" || j.status === "publishing");

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(null);
    setImporting(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/batch/import", { method: "POST", body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "导入失败");
      setRows((prev) => [...prev, ...(data.products as ListingInput[])]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "导入失败");
    } finally {
      setImporting(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  function updateRow(i: number, patch: Partial<ListingInput>) {
    setRows((rs) => rs.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  }
  function addRow() {
    setRows((rs) => [...rs, { productName: "", keywords: [], price: 1990, discount: 30 }]);
  }

  async function enqueue() {
    const valid = rows.filter((r) => r.productName.trim());
    if (!valid.length) {
      setError("请先导入或填写至少一个商品");
      return;
    }
    setEnqueuing(true);
    setError(null);
    try {
      const res = await fetch("/api/batch/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rows: valid, autoPublish }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "入队失败");
      setJobs(data.jobs);
      setRows([]); // moved into queue
    } catch (e) {
      setError(e instanceof Error ? e.message : "入队失败");
    } finally {
      setEnqueuing(false);
    }
  }

  async function clear(which: "finished" | "all") {
    const r = await fetch(`/api/batch/jobs?which=${which}`, { method: "DELETE" });
    if (r.ok) setJobs((await r.json()).jobs);
  }

  const counts = {
    total: jobs.length,
    done: jobs.filter((j) => j.status === "done").length,
    error: jobs.filter((j) => j.status === "error").length,
  };

  return (
    <div className="animate-fade-up">
      <div className="mb-8 max-w-2xl">
        <h1 className="text-[28px] font-semibold leading-tight tracking-tight text-white sm:text-[34px]">
          批量上架
        </h1>
        <p className="mt-2.5 text-[15px] leading-relaxed text-slate-400">
          导入 Excel 自动整理成商品行，加入队列依次生成与上架。开启「自动上架」则免人工预览、直接发布。
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-[1fr_minmax(360px,420px)]">
        {/* ── Left: import + rows ── */}
        <div className="space-y-6">
          <div className="card p-6">
            <div className="mb-4 flex items-center justify-between">
              <div className="flex items-center gap-2 text-sm font-medium text-slate-200">
                <FileSpreadsheet className="h-4 w-4 text-wb-pink" /> 商品列表
              </div>
              <div className="flex gap-2">
                <button className="btn-ghost px-3 py-1.5 text-xs" onClick={() => fileRef.current?.click()} disabled={importing}>
                  {importing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
                  导入 Excel
                </button>
                <button className="btn-ghost px-3 py-1.5 text-xs" onClick={addRow}>
                  <Plus className="h-3.5 w-3.5" /> 加一行
                </button>
              </div>
              <input ref={fileRef} type="file" accept=".xlsx" hidden onChange={onFile} />
            </div>

            {rows.length === 0 ? (
              <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-white/10 py-12 text-center text-sm text-slate-500">
                <FileSpreadsheet className="mb-2 h-7 w-7 text-slate-600" />
                导入 .xlsx（任意格式，AI 自动整理）或手动加一行
              </div>
            ) : (
              <div className="space-y-2">
                <div className="grid grid-cols-[1fr_1fr_72px_56px_28px] gap-2 px-1 text-[11px] uppercase tracking-wide text-slate-500">
                  <span>商品名</span><span>关键字(逗号)</span><span>价格</span><span>折扣%</span><span />
                </div>
                <div className="max-h-[420px] space-y-2 overflow-auto">
                  {rows.map((r, i) => (
                    <div key={i} className="grid grid-cols-[1fr_1fr_72px_56px_28px] gap-2">
                      <input className="input px-2.5 py-1.5 text-xs" value={r.productName}
                        onChange={(e) => updateRow(i, { productName: e.target.value })} placeholder="商品名" />
                      <input className="input px-2.5 py-1.5 text-xs" value={r.keywords.join(", ")}
                        onChange={(e) => updateRow(i, { keywords: e.target.value.split(/[,，]/).map((s) => s.trim()).filter(Boolean) })} placeholder="降噪, 长续航" />
                      <input type="number" className="input px-2 py-1.5 text-xs" value={r.price}
                        onChange={(e) => updateRow(i, { price: Number(e.target.value) })} />
                      <input type="number" className="input px-2 py-1.5 text-xs" value={r.discount}
                        onChange={(e) => updateRow(i, { discount: Number(e.target.value) })} />
                      <button className="grid place-items-center text-slate-500 hover:text-rose-400"
                        onClick={() => setRows((rs) => rs.filter((_, idx) => idx !== i))}>
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {error && <p className="mt-3 text-sm text-rose-400">{error}</p>}
          </div>
        </div>

        {/* ── Right: enqueue + queue ── */}
        <div className="space-y-6">
          <div className="card h-fit p-6">
            <div className="mb-4 text-sm font-medium text-slate-200">加入队列</div>
            <label className="flex cursor-pointer items-start gap-2.5 text-sm text-slate-200">
              <input type="checkbox" className="mt-0.5 h-4 w-4 accent-wb-purple" checked={autoPublish}
                onChange={(e) => setAutoPublish(e.target.checked)} />
              <span>
                生成后<b>自动上架</b>（免人工预览）
                <span className="mt-0.5 block text-xs text-slate-500">
                  关闭则只生成草稿，去「上架记录」逐个确认；开启则直接发布到 WB。
                </span>
              </span>
            </label>
            <button className="btn-primary mt-5 w-full" onClick={enqueue} disabled={enqueuing || rows.length === 0}>
              {enqueuing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Rocket className="h-4 w-4" />}
              加入队列（{rows.filter((r) => r.productName.trim()).length}）
            </button>
          </div>

          <div className="card p-6">
            <div className="mb-3 flex items-center justify-between">
              <div className="flex items-center gap-2 text-sm font-medium text-slate-200">
                队列 {active && <Loader2 className="h-3.5 w-3.5 animate-spin text-wb-pink" />}
              </div>
              {jobs.length > 0 && (
                <div className="flex gap-2 text-xs">
                  <button className="text-slate-500 hover:text-slate-300" onClick={() => clear("finished")}>清完成</button>
                  <button className="text-slate-500 hover:text-rose-400" onClick={() => clear("all")}>清空</button>
                </div>
              )}
            </div>
            {jobs.length > 0 && (
              <div className="mb-3 text-xs text-slate-400">
                共 {counts.total} · 完成 <b className="text-emerald-400">{counts.done}</b> · 失败 <b className="text-rose-400">{counts.error}</b>
              </div>
            )}
            {jobs.length === 0 ? (
              <p className="py-6 text-center text-sm text-slate-500">队列为空</p>
            ) : (
              <div className="max-h-[420px] space-y-1.5 overflow-auto">
                {jobs.map((j) => {
                  const s = STATUS[j.status];
                  const Icon = s.icon;
                  const spin = j.status === "generating" || j.status === "publishing";
                  return (
                    <div key={j.id} className="flex items-center gap-2 rounded-lg bg-white/[0.02] px-3 py-2 text-xs">
                      <Icon className={clsx("h-3.5 w-3.5 shrink-0", s.cls, spin && "animate-spin")} />
                      <span className="min-w-0 flex-1 truncate text-slate-200">{j.input.productName}</span>
                      {j.nmID && <span className="shrink-0 text-slate-500">nmID {j.nmID}</span>}
                      <span className={clsx("shrink-0", s.cls)}>{s.label}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
