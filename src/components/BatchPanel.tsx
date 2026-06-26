"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  Upload,
  Loader2,
  Plus,
  Rocket,
  FileSpreadsheet,
  CheckCircle2,
  Folder,
  Video,
  ImageIcon,
  Pause,
  Clock,
  ShieldCheck,
  Info,
  ArrowRight,
  X,
} from "lucide-react";
import clsx from "clsx";
import { api, type Job } from "@/lib/api";
import { EnvBadge } from "./EnvBadge";
import { envKind } from "@/lib/env";
import type { ListingInput, Listing } from "@/lib/types";

type Row = {
  productName: string;
  price: number;
  keywords: string[];
  brand?: string;
  discount: number;
  basePhotos: string[]; // matched real photos (data URLs)
  videoName: string | null; // matched video file name (display only in v1)
};

const norm = (s: string) => s.toLowerCase().replace(/[\s_\-．。]+/g, "");

function rowReady(r: Row) {
  return !!r.productName.trim() && r.price > 0;
}
function rowStatus(r: Row): "ok" | "warn" | "err" {
  if (!r.productName.trim()) return "err";
  if (!(r.price > 0)) return "warn";
  return "ok";
}

const STEPS = ["1 · 导入", "2 · 生成草稿", "3 · 审核(双语)", "4 · 发布"];

export function BatchPanel() {
  const [step, setStep] = useState(0);
  const [rows, setRows] = useState<Row[]>([]);
  const [importing, setImporting] = useState(false);
  const [matching, setMatching] = useState(false);
  const [matchMsg, setMatchMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [env, setEnv] = useState<{ dryRun: boolean; wbSandbox: boolean } | null>(null);
  const [enqueuing, setEnqueuing] = useState(false);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [jobListings, setJobListings] = useState<Listing[]>([]);
  const [lang, setLang] = useState<"ru" | "zh" | "both">("both");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [publishing, setPublishing] = useState(false);
  const [pub, setPub] = useState<Record<string, "wait" | "run" | "ok" | "err">>({});
  const [pubNm, setPubNm] = useState<Record<string, number>>({});
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api
      .getSettings()
      .then((s) => setEnv({ dryRun: s.dryRun, wbSandbox: s.wbSandbox }))
      .catch(() => {});
  }, []);

  const active = jobs.some(
    (j) => j.status === "pending" || j.status === "generating" || j.status === "publishing"
  );

  // poll jobs while on the generate step
  useEffect(() => {
    if (step !== 1) return;
    let alive = true;
    const tick = () => api.listJobs().then((j) => alive && setJobs(j)).catch(() => {});
    tick();
    const id = setInterval(tick, 2500);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [step]);

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(null);
    setImporting(true);
    try {
      const buf = new Uint8Array(await file.arrayBuffer());
      const products = await api.importExcel(Array.from(buf));
      setRows((prev) => [
        ...prev,
        ...products.map((p) => ({
          productName: p.productName,
          price: p.price,
          keywords: p.keywords ?? [],
          brand: p.brand,
          discount: p.discount ?? 0,
          basePhotos: [],
          videoName: null,
        })),
      ]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "导入失败");
    } finally {
      setImporting(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  function addRow() {
    setRows((rs) => [
      ...rs,
      { productName: "", price: 1990, keywords: [], discount: 0, basePhotos: [], videoName: null },
    ]);
  }
  function updateRow(i: number, patch: Partial<Row>) {
    setRows((rs) => rs.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  }

  // 关联素材文件夹: pick folder → list files → match by 文件名 == 商品名(规整后)
  const linkFolder = useCallback(async () => {
    setError(null);
    const dir = await api.pickFolder().catch(() => null);
    if (!dir) return;
    setMatching(true);
    try {
      const files = await api.listMediaFiles(dir);
      let imgHit = 0;
      let vidHit = 0;
      // match each row against the folder
      const next = await Promise.all(
        rows.map(async (r) => {
          const key = norm(r.productName);
          if (!key) return r;
          const imgs = files.filter(
            (f) => f.kind === "image" && (norm(f.stem) === key || norm(f.stem).startsWith(key))
          );
          const vid = files.find(
            (f) => f.kind === "video" && (norm(f.stem) === key || norm(f.stem).startsWith(key))
          );
          let basePhotos = r.basePhotos;
          if (imgs.length) {
            const urls: string[] = [];
            for (const f of imgs.slice(0, 4)) {
              try {
                urls.push(await api.readFileB64(f.path));
              } catch {
                /* skip unreadable */
              }
            }
            if (urls.length) {
              basePhotos = urls;
              imgHit++;
            }
          }
          if (vid) vidHit++;
          return { ...r, basePhotos, videoName: vid ? vid.name : r.videoName };
        })
      );
      setRows(next);
      setMatchMsg(
        `已关联文件夹:${files.length} 个素材 · 匹配到 ${imgHit} 行实拍图、${vidHit} 行视频。未匹配的行将由 AI 出图。`
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "读取文件夹失败");
    } finally {
      setMatching(false);
    }
  }, [rows]);

  const validRows = rows.filter(rowReady);

  async function startGenerate() {
    if (!validRows.length) {
      setError("请先导入或填写至少一个商品(需有商品名和售价)");
      return;
    }
    setEnqueuing(true);
    setError(null);
    try {
      const payload: ListingInput[] = validRows.map((r) => ({
        productName: r.productName,
        keywords: r.keywords,
        price: r.price,
        discount: r.discount,
        brand: r.brand,
        basePhotos: r.basePhotos.length ? r.basePhotos : undefined,
      }));
      await api.enqueueJobs(payload, false); // 只生成草稿,不自动上架
      setJobs(await api.listJobs());
      setStep(1);
    } catch (e) {
      setError(e instanceof Error ? e.message : "入队失败");
    } finally {
      setEnqueuing(false);
    }
  }

  async function toReview() {
    const ls = await api.listJobListings().catch(() => [] as Listing[]);
    setJobListings(ls);
    // pre-select all 就绪 cards
    setSelected(new Set(ls.filter((l) => listingReady(l)).map((l) => l.id)));
    setStep(2);
  }

  async function publishSelected() {
    const ids = jobListings.filter((l) => selected.has(l.id)).map((l) => l.id);
    if (!ids.length) return;
    setStep(3);
    setPublishing(true);
    setPub(Object.fromEntries(ids.map((id) => [id, "wait" as const])));
    // serial — WB throttles pricing (~1/min); sequential awaits avoid lock contention.
    for (const id of ids) {
      setPub((p) => ({ ...p, [id]: "run" }));
      try {
        const updated = await api.publish(id);
        if (updated.error && !updated.nmID) {
          setPub((p) => ({ ...p, [id]: "err" }));
        } else {
          setPub((p) => ({ ...p, [id]: "ok" }));
          if (updated.nmID) setPubNm((m) => ({ ...m, [id]: updated.nmID! }));
        }
      } catch {
        setPub((p) => ({ ...p, [id]: "err" }));
      }
    }
    setPublishing(false);
  }

  const envKindNow = env ? envKind(env.dryRun, env.wbSandbox) : "demo";
  const destName = envKindNow === "demo" ? "演示(不真实上架)" : envKindNow === "sandbox" ? "沙盒测试店铺" : "真实店铺";

  return (
    <div className="flex h-full min-h-0 flex-col animate-fade-up">
      {/* ── Header + 4-step tabs (pinned) ── */}
      <div className="shrink-0">
        <div className="mb-3 flex flex-wrap items-center gap-3">
          <h1 className="flex items-center gap-2 text-lg font-semibold tracking-tight text-slate-900 dark:text-white">
            <FileSpreadsheet className="h-5 w-5 text-wb-pink" /> 批量上架
          </h1>
          {env && <EnvBadge dryRun={env.dryRun} sandbox={env.wbSandbox} />}
        </div>
        <div className="flex gap-1 rounded-xl border border-slate-900/[0.08] bg-slate-900/[0.03] p-1 dark:border-white/[0.06] dark:bg-white/[0.03]">
          {STEPS.map((s, i) => {
            const reachable = i <= step;
            return (
              <button
                key={s}
                onClick={() => reachable && setStep(i)}
                disabled={!reachable}
                className={clsx(
                  "flex-1 rounded-lg px-2 py-1.5 text-xs font-medium transition",
                  step === i
                    ? "bg-white text-slate-900 shadow-sm dark:bg-white/[0.12] dark:text-white"
                    : reachable
                    ? "text-slate-500 hover:text-slate-700 dark:hover:text-slate-300"
                    : "text-slate-300 dark:text-slate-600"
                )}
              >
                {s}
              </button>
            );
          })}
        </div>
      </div>

      {error && (
        <div className="mt-3 shrink-0 rounded-xl border border-rose-500/30 bg-rose-500/[0.08] px-4 py-2.5 text-sm text-rose-600 dark:text-rose-300">
          {error}
        </div>
      )}

      {/* ── Step body (scrolls) ── */}
      <div className="mt-3 min-h-0 flex-1 overflow-y-auto pr-0.5">
        {step === 0 && (
          <ImportStep
            rows={rows}
            importing={importing}
            matching={matching}
            matchMsg={matchMsg}
            validCount={validRows.length}
            onImport={() => fileRef.current?.click()}
            onAddRow={addRow}
            onLinkFolder={linkFolder}
            onUpdateRow={updateRow}
            onRemoveRow={(i) => setRows((rs) => rs.filter((_, idx) => idx !== i))}
            onNext={startGenerate}
            enqueuing={enqueuing}
          />
        )}
        {step === 1 && (
          <GenerateStep
            jobs={jobs}
            rows={validRows}
            active={active}
            destName={destName}
            envKind={envKindNow}
            onReview={toReview}
          />
        )}
        {step === 2 && (
          <ReviewStep
            listings={jobListings}
            lang={lang}
            setLang={setLang}
            selected={selected}
            setSelected={setSelected}
            onPublish={publishSelected}
          />
        )}
        {step === 3 && (
          <PublishStep
            listings={jobListings.filter((l) => selected.has(l.id))}
            pub={pub}
            pubNm={pubNm}
            publishing={publishing}
            destName={destName}
          />
        )}
      </div>

      <input ref={fileRef} type="file" accept=".xlsx" hidden onChange={onFile} />
    </div>
  );
}

function listingReady(l: Listing) {
  return !l.error && !!l.copy && l.images.length > 0;
}

// ───────────────────────── Step 1: import + media matching ─────────────────────────
function ImportStep({
  rows,
  importing,
  matching,
  matchMsg,
  validCount,
  onImport,
  onAddRow,
  onLinkFolder,
  onUpdateRow,
  onRemoveRow,
  onNext,
  enqueuing,
}: {
  rows: Row[];
  importing: boolean;
  matching: boolean;
  matchMsg: string | null;
  validCount: number;
  onImport: () => void;
  onAddRow: () => void;
  onLinkFolder: () => void;
  onUpdateRow: (i: number, patch: Partial<Row>) => void;
  onRemoveRow: (i: number) => void;
  onNext: () => void;
  enqueuing: boolean;
}) {
  return (
    <div>
      <div className="mb-3 flex flex-wrap gap-2">
        <button className="btn-ghost px-3 py-2 text-xs" onClick={onImport} disabled={importing}>
          {importing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
          导入 Excel
        </button>
        <button className="btn-ghost px-3 py-2 text-xs" onClick={onAddRow}>
          <Plus className="h-3.5 w-3.5" /> 加一行
        </button>
        <button
          className="btn-ghost border-wb-pink/35 px-3 py-2 text-xs text-wb-pink"
          onClick={onLinkFolder}
          disabled={matching || rows.length === 0}
          title={rows.length === 0 ? "先导入/加行,再关联素材" : "选一个含图片/视频的文件夹,按文件名自动匹配"}
        >
          {matching ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Folder className="h-3.5 w-3.5" />}
          关联素材文件夹(图/视频)
        </button>
      </div>

      {rows.length === 0 ? (
        <div className="card flex flex-col items-center justify-center py-16 text-center text-sm text-slate-500">
          <FileSpreadsheet className="mb-2 h-8 w-8 text-slate-300 dark:text-slate-600" />
          导入 .xlsx(任意列，AI 自动整理)或「加一行」开始
        </div>
      ) : (
        <div className="card overflow-hidden p-0">
          <table className="w-full table-fixed border-collapse text-sm">
            <thead>
              <tr className="bg-slate-900/[0.03] text-left text-[11px] text-slate-500 dark:bg-white/[0.03]">
                <th className="px-3 py-2 font-medium">商品名 *</th>
                <th className="w-24 px-2 py-2 font-medium">售价 *</th>
                <th className="w-28 px-2 py-2 font-medium">图片</th>
                <th className="w-32 px-2 py-2 font-medium">视频</th>
                <th className="w-24 px-2 py-2 font-medium">状态</th>
                <th className="w-8 px-1 py-2" />
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                const st = rowStatus(r);
                return (
                  <tr key={i} className="border-t border-slate-900/[0.06] dark:border-white/[0.06]">
                    <td className="px-2 py-1.5">
                      <input
                        className={clsx("input px-2 py-1.5 text-xs", st === "err" && "border-rose-400/60")}
                        value={r.productName}
                        onChange={(e) => onUpdateRow(i, { productName: e.target.value })}
                        placeholder="商品名"
                      />
                    </td>
                    <td className="px-2 py-1.5">
                      <input
                        type="number"
                        className={clsx("input px-2 py-1.5 text-xs", st === "warn" && "border-amber-400/60")}
                        value={r.price}
                        onChange={(e) => onUpdateRow(i, { price: Number(e.target.value) })}
                      />
                    </td>
                    <td className="px-2 py-1.5">
                      {r.basePhotos.length ? (
                        <span className="inline-flex items-center gap-1 rounded-full bg-sky-500/10 px-2 py-0.5 text-[10.5px] text-sky-600 dark:text-sky-300">
                          <ImageIcon className="h-3 w-3" /> {r.basePhotos.length} 张实拍
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 rounded-full bg-wb-purple/10 px-2 py-0.5 text-[10.5px] text-wb-purple">
                          AI 出图
                        </span>
                      )}
                    </td>
                    <td className="px-2 py-1.5">
                      {r.videoName ? (
                        <span className="inline-flex max-w-full items-center gap-1 truncate rounded-full bg-wb-pink/10 px-2 py-0.5 text-[10.5px] text-wb-pink">
                          <Video className="h-3 w-3 shrink-0" /> <span className="truncate">{r.videoName}</span>
                        </span>
                      ) : (
                        <span className="text-xs text-slate-300 dark:text-slate-600">—</span>
                      )}
                    </td>
                    <td className="px-2 py-1.5">
                      {st === "ok" ? (
                        <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10.5px] text-emerald-600 dark:text-emerald-300">
                          <CheckCircle2 className="h-3 w-3" /> 就绪
                        </span>
                      ) : st === "warn" ? (
                        <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-[10.5px] text-amber-600 dark:text-amber-300">缺售价</span>
                      ) : (
                        <span className="rounded-full bg-rose-500/10 px-2 py-0.5 text-[10.5px] text-rose-600 dark:text-rose-300">缺名</span>
                      )}
                    </td>
                    <td className="px-1 py-1.5 text-center">
                      <button
                        className="text-slate-400 hover:text-rose-600 dark:hover:text-rose-400"
                        onClick={() => onRemoveRow(i)}
                        title="删除这一行"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <p className="mt-3 flex items-start gap-1.5 text-[11px] leading-relaxed text-slate-400">
        <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        素材按「商品名 = 文件名」自动匹配:匹配到实拍图就用实拍、否则 AI 出图;匹配到的视频会显示在「视频」列(配俄语目前在单品页做)。缺必填的行(红/黄)不会进生成。
      </p>
      {matchMsg && (
        <p className="mt-1.5 text-[11px] text-emerald-600 dark:text-emerald-400">{matchMsg}</p>
      )}

      <div className="mt-4 flex justify-end">
        <button className="btn-primary" onClick={onNext} disabled={enqueuing || validCount === 0}>
          {enqueuing ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowRight className="h-4 w-4" />}
          下一步:生成草稿（{validCount} 行就绪）
        </button>
      </div>
    </div>
  );
}

// ───────────────────────── Step 2: generate drafts ─────────────────────────
function GenerateStep({
  jobs,
  rows,
  active,
  destName,
  envKind,
  onReview,
}: {
  jobs: Job[];
  rows: Row[];
  active: boolean;
  destName: string;
  envKind: string;
  onReview: () => void;
}) {
  const imgs = rows.reduce((n, r) => n + (r.basePhotos.length ? r.basePhotos.length : 3), 0);
  const vids = rows.filter((r) => r.videoName).length;
  const mins = Math.ceil(imgs * 2.5);
  const done = jobs.length > 0 && !active;

  return (
    <div>
      <div className="mb-4 grid grid-cols-2 gap-2.5 sm:grid-cols-4">
        {[
          ["商品", `${rows.length} 个`],
          ["配图", `约 ${imgs} 张`],
          ["视频", `${vids} 个`],
          ["预计", `~${mins} 分钟`],
        ].map(([k, v]) => (
          <div key={k} className="rounded-xl bg-slate-900/[0.04] px-3.5 py-3 dark:bg-white/5">
            <div className="text-[10.5px] text-slate-500">{k}</div>
            <div className="text-base font-medium text-slate-900 dark:text-slate-100">{v}</div>
          </div>
        ))}
      </div>

      <div className="mb-4 flex items-start gap-2 rounded-xl border border-amber-400/30 bg-amber-500/[0.08] px-4 py-3 text-xs leading-relaxed text-amber-700 dark:text-amber-200">
        <Clock className="mt-0.5 h-4 w-4 shrink-0" />
        预计消耗你的 Aurixel 余额;目标:<b className="mx-0.5">{destName}</b>。仅生成草稿，
        <b>不会自动上架</b>，生成完到下一步逐个审核。
      </div>

      <div className="card divide-y divide-slate-900/[0.06] p-0 dark:divide-white/[0.06]">
        {jobs.length === 0 ? (
          <div className="px-4 py-6 text-center text-sm text-slate-500">准备入队…</div>
        ) : (
          jobs.map((j) => {
            const label =
              j.status === "done"
                ? { t: "✓ 草稿就绪", c: "text-emerald-600 dark:text-emerald-400", spin: false }
                : j.status === "error"
                ? { t: "✗ " + (j.error?.slice(0, 30) || "失败"), c: "text-rose-600 dark:text-rose-400", spin: false }
                : j.status === "generating"
                ? { t: "生成中(图文+俄语文案)", c: "text-amber-600 dark:text-amber-300", spin: true }
                : j.status === "publishing"
                ? { t: "上架中", c: "text-sky-600 dark:text-sky-300", spin: true }
                : { t: "排队", c: "text-slate-400", spin: false };
            return (
              <div key={j.id} className="flex items-center gap-2 px-4 py-2.5 text-xs">
                <span className="min-w-0 flex-1 truncate text-slate-800 dark:text-slate-200">
                  {j.input.productName}
                </span>
                <span className={clsx("flex items-center gap-1", label.c)}>
                  {label.spin && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                  {label.t}
                </span>
              </div>
            );
          })
        )}
      </div>

      <div className="mt-4 flex items-center justify-end gap-2">
        <button className="btn-primary" onClick={onReview} disabled={!done}>
          {active ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" /> 生成中…
            </>
          ) : (
            <>
              <ArrowRight className="h-4 w-4" /> 去审核（双语）
            </>
          )}
        </button>
      </div>
    </div>
  );
}

// ───────────────────────── Step 3: bilingual review grid ─────────────────────────
function ReviewStep({
  listings,
  lang,
  setLang,
  selected,
  setSelected,
  onPublish,
}: {
  listings: Listing[];
  lang: "ru" | "zh" | "both";
  setLang: (l: "ru" | "zh" | "both") => void;
  selected: Set<string>;
  setSelected: React.Dispatch<React.SetStateAction<Set<string>>>;
  onPublish: () => void;
}) {
  const ready = listings.filter(listingReady);
  const failed = listings.filter((l) => !listingReady(l));
  const showRu = lang !== "zh";
  const showZh = lang !== "ru";

  function toggle(id: string) {
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }

  if (listings.length === 0) {
    return (
      <div className="card px-4 py-12 text-center text-sm text-slate-500">
        还没有草稿。回到上一步生成,或这批已被清空。
      </div>
    );
  }

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2.5">
        <div className="flex gap-0.5 rounded-lg border border-slate-900/[0.08] bg-slate-900/[0.03] p-0.5 dark:border-white/[0.06] dark:bg-white/[0.03]">
          {(["ru", "zh", "both"] as const).map((m) => (
            <button
              key={m}
              onClick={() => setLang(m)}
              className={clsx(
                "rounded-md px-3 py-0.5 text-[11px] font-medium transition",
                lang === m
                  ? "bg-white text-slate-900 shadow-sm dark:bg-white/[0.12] dark:text-white"
                  : "text-slate-500 hover:text-slate-700 dark:hover:text-slate-300"
              )}
            >
              {m === "ru" ? "俄" : m === "zh" ? "中" : "双语"}
            </button>
          ))}
        </div>
        <span className="text-xs text-slate-500 dark:text-slate-400">
          就绪 <b className="text-emerald-600 dark:text-emerald-400">{ready.length}</b> · 失败/待修{" "}
          <b className="text-rose-600 dark:text-rose-400">{failed.length}</b>
        </span>
        <button
          className="btn-ghost ml-auto px-3 py-1.5 text-xs"
          onClick={() => setSelected(new Set(ready.map((l) => l.id)))}
        >
          全选就绪
        </button>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {listings.map((l) => {
          const ok = listingReady(l);
          const main = l.images.find((i) => i.kind === "main") ?? l.images[0];
          const lDisc = Math.max(0, Math.min(99, l.discount || 0));
          const finalP = lDisc > 0 ? Math.round(l.price * (1 - lDisc / 100)) : l.price;
          return (
            <div
              key={l.id}
              className={clsx(
                "overflow-hidden rounded-xl border bg-white dark:bg-white/[0.02]",
                ok ? "border-emerald-500/40" : "border-rose-500/40"
              )}
            >
              <div className="relative aspect-[4/3] bg-slate-900/[0.04] dark:bg-white/5">
                {main ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={main.url} alt="" className="h-full w-full object-cover" />
                ) : (
                  <div className="grid h-full w-full place-items-center text-slate-300">
                    <ImageIcon className="h-6 w-6" />
                  </div>
                )}
                {l.videoRu && (
                  <span className="absolute right-1.5 top-1.5 inline-flex items-center gap-1 rounded-full bg-emerald-700/85 px-1.5 py-0.5 text-[10px] text-white">
                    <Video className="h-3 w-3" /> 俄
                  </span>
                )}
              </div>
              <div className="p-2.5">
                {showRu && (
                  <div className="truncate text-xs font-medium text-slate-900 dark:text-slate-100">
                    {l.copy?.title || l.productName}
                  </div>
                )}
                {showZh && (l.copy?.titleZh || !showRu) && (
                  <div className="truncate text-[11px] text-slate-500 dark:text-slate-400">
                    {l.copy?.titleZh || l.productName}
                  </div>
                )}
                <div className="mt-1.5 flex items-center justify-between">
                  <span className="text-[11px] text-slate-600 dark:text-slate-300">
                    {finalP.toLocaleString()} ₽
                  </span>
                  {ok ? (
                    <label className="flex cursor-pointer items-center gap-1 text-[10.5px] text-slate-500">
                      <input
                        type="checkbox"
                        className="h-3.5 w-3.5 accent-wb-pink"
                        checked={selected.has(l.id)}
                        onChange={() => toggle(l.id)}
                      />
                      发布
                    </label>
                  ) : (
                    <ContinueDraft id={l.id} />
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <div className="mt-4 flex items-center justify-between border-t border-slate-900/[0.06] pt-3 dark:border-white/[0.06]">
        <span className="text-xs text-slate-500 dark:text-slate-400">已选 {selected.size} 张就绪卡片</span>
        <button className="btn-primary" onClick={onPublish} disabled={selected.size === 0}>
          <Rocket className="h-4 w-4" /> 发布选中 {selected.size} 张
        </button>
      </div>
    </div>
  );
}

function ContinueDraft({ id }: { id: string }) {
  return (
    <button
      className="btn-ghost px-2.5 py-1 text-[10.5px]"
      onClick={() => {
        try {
          sessionStorage.setItem("wb:listingId", id);
          sessionStorage.removeItem("wb:generating");
        } catch {
          /* ignore */
        }
        window.location.href = "/";
      }}
    >
      修正
    </button>
  );
}

// ───────────────────────── Step 4: publish ─────────────────────────
function PublishStep({
  listings,
  pub,
  pubNm,
  publishing,
  destName,
}: {
  listings: Listing[];
  pub: Record<string, "wait" | "run" | "ok" | "err">;
  pubNm: Record<string, number>;
  publishing: boolean;
  destName: string;
}) {
  const okCount = Object.values(pub).filter((s) => s === "ok").length;
  return (
    <div>
      <div className="card mb-3 p-4">
        <div className="mb-2 text-sm text-slate-800 dark:text-slate-100">
          发布 <b>{listings.length} 张</b> 到 <b>{destName}</b>
          {!publishing && okCount > 0 && (
            <span className="ml-2 text-emerald-600 dark:text-emerald-400">· 完成 {okCount}</span>
          )}
        </div>
        <div className="flex items-start gap-2 rounded-lg border border-amber-400/30 bg-amber-500/[0.08] px-3 py-2.5 text-[11px] leading-relaxed text-amber-700 dark:text-amber-200">
          <Clock className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          WB 价格接口限流(约每分钟 1 张定价),{listings.length} 张约 {listings.length} 分钟。建卡+传图更快,定价是瓶颈,后台慢慢推即可。
        </div>
      </div>

      <div className="card divide-y divide-slate-900/[0.06] p-0 dark:divide-white/[0.06]">
        {listings.map((l) => {
          const s = pub[l.id] ?? "wait";
          return (
            <div key={l.id} className="flex items-center gap-2 px-4 py-2.5 text-xs">
              <span className="min-w-0 flex-1 truncate text-slate-800 dark:text-slate-200">
                {l.copy?.title || l.productName}
              </span>
              {s === "ok" ? (
                <span className="text-emerald-600 dark:text-emerald-400">
                  ✓ {pubNm[l.id] ? `nmID ${pubNm[l.id]}` : "完成"}
                </span>
              ) : s === "run" ? (
                <span className="flex items-center gap-1 text-sky-600 dark:text-sky-300">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" /> 上架中…
                </span>
              ) : s === "err" ? (
                <span className="text-rose-600 dark:text-rose-400">✗ 失败,可重试</span>
              ) : (
                <span className="text-slate-400">排队</span>
              )}
            </div>
          );
        })}
      </div>

      <p className="mt-3 flex items-center gap-1.5 text-[11px] text-slate-400">
        <ShieldCheck className="h-3.5 w-3.5" /> 已建过的卡不会重复创建(幂等);失败项可回上一步重发。
      </p>

      {!publishing && okCount > 0 && (
        <div className="mt-4 flex justify-end">
          <Link href="/manage" className="btn-ghost">
            去商品管理查看
          </Link>
        </div>
      )}
    </div>
  );
}
