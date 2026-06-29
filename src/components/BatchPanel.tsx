"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
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
import { DUB_PRESETS, DUB_PRESET_DEFAULT, dubPresetOptions, type DubPreset } from "@/lib/dub";
import { EnvBadge } from "./EnvBadge";
import { envKind } from "@/lib/env";
import type { ListingInput, Listing } from "@/lib/types";

type Row = {
  productName: string;
  price: number;
  keywords: string[];
  brand?: string;
  discount: number;
  basePhotos: string[]; // matched real photos (data URLs) — NOT persisted (too big)
  basePhotoPaths: string[]; // matched photo file paths — persisted; re-read on return
  videoName: string | null; // matched video file name (display)
  videoPath: string | null; // matched video absolute path (for 配俄语 after generate)
};

const norm = (s: string) => s.toLowerCase().replace(/[\s_\-．。]+/g, "");

// ── Import-table persistence (survives tab switches; cleared on app restart) ──
// sessionStorage can't hold the matched photos' base64 (too big), so we store the
// photo PATHS and re-read them on load. These are module-level so an async import
// that resolves AFTER the component unmounted can still persist + notify reliably.
const ROWS_KEY = "wb:batchRows";
function persistRowsLite(rs: Row[]) {
  try {
    sessionStorage.setItem(ROWS_KEY, JSON.stringify(rs.map((r) => ({ ...r, basePhotos: [] }))));
  } catch {
    /* quota — skip */
  }
}
function readRowsLite(): Row[] {
  try {
    const a = JSON.parse(sessionStorage.getItem(ROWS_KEY) || "[]");
    return Array.isArray(a) ? a : [];
  } catch {
    return [];
  }
}

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
  // 批量配俄语进度(前端串行复用 dub_start + set_listing_video)
  const [dubbing, setDubbing] = useState<{ done: number; total: number } | null>(null);
  const [dubMsg, setDubMsg] = useState<string | null>(null);
  const [dubPreset, setDubPreset] = useState<DubPreset>(DUB_PRESET_DEFAULT);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api
      .getSettings()
      .then((s) => setEnv({ dryRun: s.dryRun, wbSandbox: s.wbSandbox }))
      .catch(() => {});
  }, []);

  // Load the import table from storage into state (+ re-read matched photos from
  // their paths). One loader used on mount AND whenever an async import/match
  // finishes — see `wb:rows` below. A monotonic id guards against a slow photo
  // re-read from an earlier call clobbering a newer load (rapid `wb:rows`).
  const loadIdRef = useRef(0);
  const loadRows = useCallback(async () => {
    const myId = ++loadIdRef.current;
    const lite = readRowsLite();
    setRows(lite);
    if (!lite.some((r) => r.basePhotoPaths?.length)) return;
    const filled = await Promise.all(
      lite.map(async (r) => {
        if (!r.basePhotoPaths?.length) return r;
        const urls: string[] = [];
        for (const p of r.basePhotoPaths) {
          try {
            urls.push(await api.readFileB64(p));
          } catch {
            /* file moved/unreadable — skip */
          }
        }
        return urls.length ? { ...r, basePhotos: urls } : r;
      })
    );
    // Only the most recent load applies its photos — a stale in-flight read must
    // not overwrite a newer table.
    if (myId === loadIdRef.current) setRows(filled);
  }, []);

  // Mount: load the saved table, and listen for `wb:rows` — a window event fired
  // when an Excel import / folder match completes. Because it's a WINDOW event,
  // it's caught by whatever instance is mounted NOW, even if the import was
  // started by an earlier instance that unmounted mid-flight (the reported bug:
  // switching tabs at the instant of import dropped it). The data itself is
  // already persisted by then, so this just refreshes the live UI.
  useEffect(() => {
    void loadRows();
    const h = () => void loadRows();
    window.addEventListener("wb:rows", h);
    return () => window.removeEventListener("wb:rows", h);
  }, [loadRows]);

  // Persist sync edits (add/edit/remove row). Skip first run so it can't clobber
  // the saved table before the initial load applies. Async imports/matches persist
  // themselves directly (below) so they survive an unmount mid-operation.
  const skipRowPersist = useRef(true);
  useEffect(() => {
    if (skipRowPersist.current) {
      skipRowPersist.current = false;
      return;
    }
    persistRowsLite(rows);
  }, [rows]);

  // Re-hydrate on mount: the queue lives in the Rust backend, so switching tabs
  // and coming back must NOT lose an in-flight batch. If jobs are running (or we
  // were past the import step), restore the step + jobs (+ the review grid).
  useEffect(() => {
    let alive = true;
    let saved = 0;
    try {
      saved = Number(sessionStorage.getItem("wb:batchStep") || "0");
    } catch {
      /* ignore */
    }
    (async () => {
      const js = await api.listJobs().catch(() => [] as Job[]);
      if (!alive || !js.length) return;
      const anyActive = js.some(
        (j) => j.status === "pending" || j.status === "generating" || j.status === "publishing"
      );
      // Fresh visit with only stale finished jobs lingering → stay on import.
      if (!anyActive && saved < 1) return;
      setJobs(js);
      let s = saved >= 1 ? saved : 1;
      if (s >= 2) {
        const ls = await api.listJobListings().catch(() => [] as Listing[]);
        if (alive && ls.length) {
          setJobListings(ls);
          setSelected(new Set(ls.filter((l) => listingReady(l)).map((l) => l.id)));
        } else {
          s = 1; // listings cleared → fall back to the generate view
        }
      }
      if (alive) setStep(s);
    })();
    return () => {
      alive = false;
    };
  }, []);

  // Persist the wizard step so a tab switch returns to the same place.
  useEffect(() => {
    try {
      sessionStorage.setItem("wb:batchStep", String(step));
    } catch {
      /* ignore */
    }
  }, [step]);

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
      const imported: Row[] = products.map((p) => ({
        productName: p.productName,
        price: p.price,
        keywords: p.keywords ?? [],
        brand: p.brand,
        discount: p.discount ?? 0,
        basePhotos: [],
        basePhotoPaths: [],
        videoName: null,
        videoPath: null,
      }));
      // Persist FIRST (module-level, so it lands even if this handler resolved
      // after the component unmounted), then notify whatever instance is mounted
      // to refresh from storage. This is what stops a tab-switch at the instant of
      // import from dropping the rows.
      persistRowsLite([...readRowsLite(), ...imported]);
      window.dispatchEvent(new Event("wb:rows"));
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
      {
        productName: "",
        price: 1990,
        keywords: [],
        discount: 0,
        basePhotos: [],
        basePhotoPaths: [],
        videoName: null,
        videoPath: null,
      },
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
          let basePhotoPaths = r.basePhotoPaths;
          if (imgs.length) {
            const urls: string[] = [];
            const paths: string[] = [];
            for (const f of imgs.slice(0, 4)) {
              try {
                urls.push(await api.readFileB64(f.path));
                paths.push(f.path);
              } catch {
                /* skip unreadable */
              }
            }
            if (urls.length) {
              basePhotos = urls;
              basePhotoPaths = paths;
              imgHit++;
            }
          }
          if (vid) vidHit++;
          return {
            ...r,
            basePhotos,
            basePhotoPaths,
            videoName: vid ? vid.name : r.videoName,
            videoPath: vid ? vid.path : r.videoPath,
          };
        })
      );
      setRows(next);
      persistRowsLite(next); // survive a tab switch mid-match (paths are persisted)
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
      // 入队前清掉上一批【已完成/失败】的旧任务,免得生成进度列表混入历史记录
      // (它们产出的草稿仍在「上架记录 › 草稿箱」,不会丢)。在途的不会被清。
      await api.clearJobs("finished").catch(() => {});
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
    void dubMatchedVideos(ls); // 后台串行配俄语,卡片角标随完成更新(不阻塞审核)
  }

  // Dub each matched English video → RU and attach to its listing. Frontend-
  // orchestrated (reuses dub_start + set_listing_video); serial because the dub
  // backend allows one job at a time. Cards show the 俄 badge as each finishes.
  async function dubMatchedVideos(listings: Listing[]) {
    const tasks = listings
      .map((l) => {
        const row = rows.find((r) => r.productName === l.productName && r.videoPath);
        return row?.videoPath && !l.videoRu ? { id: l.id, path: row.videoPath } : null;
      })
      .filter((t): t is { id: string; path: string } => t !== null);
    if (!tasks.length) return;
    const pf = await api.dubPreflight().catch(() => null);
    if (!pf?.ready) {
      setDubMsg("配音环境未就绪,视频未配 —— 可到单品页单独配。");
      return;
    }
    setDubMsg(null);
    setDubbing({ done: 0, total: tasks.length });
    for (let i = 0; i < tasks.length; i++) {
      const t = tasks[i];
      try {
        const out = await api.dubStart({
          inputPath: t.path,
          voiceMode: "clone",
          ...dubPresetOptions(dubPreset),
        });
        const updated = await api.setListingVideo(t.id, out);
        setJobListings((cur) => cur.map((l) => (l.id === t.id ? updated : l)));
      } catch {
        /* skip this one; others continue */
      }
      setDubbing({ done: i + 1, total: tasks.length });
    }
    setDubbing(null);
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
            onClearFinished={async () => setJobs(await api.clearJobs("finished"))}
            hasVideos={validRows.some((r) => r.videoPath)}
            dubPreset={dubPreset}
            setDubPreset={setDubPreset}
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
            dubbing={dubbing}
            dubMsg={dubMsg}
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

      {/* Blocking progress overlay: import + folder-match both call the AI and can
          take ~10s. Covering the whole viewport (above the nav) both reassures the
          user it's working AND prevents a tab switch mid-operation (防呆). */}
      <ImportOverlay
        active={importing || matching}
        label={importing ? "正在导入并用 AI 整理表格…" : "正在匹配素材文件夹…"}
      />
    </div>
  );
}

// Full-screen blocking progress while an async import/match runs. The bar eases
// toward ~92% over time and the elapsed seconds tick up, so a 10s AI call never
// looks frozen; it snaps away when the operation finishes (active → false).
//
// IMPORTANT: rendered via a PORTAL to document.body. The panel root carries
// `animate-fade-up`, whose fill-mode leaves a lingering `transform` on the div —
// and a transformed ancestor becomes the containing block for `position: fixed`,
// which would otherwise trap this overlay inside the content area (below the nav)
// and let nav clicks through. Portaling to <body> escapes that ancestor so the
// overlay truly covers the whole viewport (incl. the nav) and blocks navigation.
function ImportOverlay({ active, label }: { active: boolean; label: string }) {
  const [pct, setPct] = useState(0);
  const [sec, setSec] = useState(0);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  useEffect(() => {
    if (!active) {
      setPct(0);
      setSec(0);
      return;
    }
    const t0 = Date.now();
    setPct(8);
    const id = setInterval(() => {
      const elapsed = (Date.now() - t0) / 1000;
      setSec(Math.floor(elapsed));
      setPct(Math.min(92, 8 + 84 * (1 - Math.exp(-elapsed / 8))));
    }, 200);
    return () => clearInterval(id);
  }, [active]);

  if (!active || !mounted) return null;
  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-900/40 p-4 backdrop-blur-sm">
      <div className="card w-[min(92vw,380px)] p-6 text-center">
        <Loader2 className="mx-auto mb-3 h-7 w-7 animate-spin text-wb-pink" />
        <div className="text-sm font-medium text-slate-800 dark:text-slate-100">{label}</div>
        <div className="mt-1 text-[11px] text-slate-500 dark:text-slate-400">
          已用时 {sec}s · 通常 5–15 秒（按商品数量而定）
        </div>
        <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-slate-900/[0.08] dark:bg-white/10">
          <div
            className="h-full rounded-full bg-gradient-to-r from-wb-pink to-wb-purple transition-[width] duration-200 ease-out"
            style={{ width: `${pct}%` }}
          />
        </div>
        <div className="mt-3 text-[11px] text-slate-400">整理完成前请勿离开此页</div>
      </div>
    </div>,
    document.body
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
        素材按「商品名 = 文件名」自动匹配:匹配到实拍图就用实拍、否则 AI 出图;匹配到的视频会在生成后自动配成俄语并挂到卡片上(在审核步骤逐条配音)。缺必填的行(红/黄)不会进生成。
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
  onClearFinished,
  hasVideos,
  dubPreset,
  setDubPreset,
}: {
  jobs: Job[];
  rows: Row[];
  active: boolean;
  destName: string;
  envKind: string;
  onReview: () => void;
  onClearFinished: () => void;
  hasVideos: boolean;
  dubPreset: DubPreset;
  setDubPreset: (p: DubPreset) => void;
}) {
  const finishedCount = jobs.filter((j) => j.status === "done" || j.status === "error").length;
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

      {hasVideos && (
        <div className="mb-4 rounded-xl border border-slate-900/[0.08] bg-slate-900/[0.02] px-4 py-3 dark:border-white/[0.07] dark:bg-white/[0.02]">
          <div className="mb-1.5 flex items-center gap-1.5 text-xs text-slate-600 dark:text-slate-300">
            <Video className="h-3.5 w-3.5 text-wb-pink" /> 视频配俄语质量（去审核时自动配音）
          </div>
          <div className="flex gap-0.5 rounded-lg border border-slate-900/[0.08] bg-slate-900/[0.03] p-0.5 dark:border-white/[0.06] dark:bg-white/[0.03]">
            {DUB_PRESETS.map((p) => (
              <button
                key={p.id}
                onClick={() => setDubPreset(p.id)}
                title={p.hint}
                className={clsx(
                  "flex-1 rounded-md px-2 py-1 text-[11px] font-medium transition",
                  dubPreset === p.id
                    ? "bg-white text-slate-900 shadow-sm dark:bg-white/[0.14] dark:text-white"
                    : "text-slate-500 hover:text-slate-700 dark:hover:text-slate-300"
                )}
              >
                {p.label}
              </button>
            ))}
          </div>
          <p className="mt-1.5 text-[10.5px] text-slate-400">
            {DUB_PRESETS.find((p) => p.id === dubPreset)?.hint}
          </p>
        </div>
      )}

      <div className="mb-1.5 flex items-center justify-between px-1">
        <span className="text-xs text-slate-500 dark:text-slate-400">生成进度</span>
        {finishedCount > 0 && (
          <button
            onClick={onClearFinished}
            className="text-[11px] text-slate-500 hover:text-rose-600 dark:hover:text-rose-400"
          >
            清空已完成({finishedCount})
          </button>
        )}
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
  dubbing,
  dubMsg,
}: {
  listings: Listing[];
  lang: "ru" | "zh" | "both";
  setLang: (l: "ru" | "zh" | "both") => void;
  selected: Set<string>;
  setSelected: React.Dispatch<React.SetStateAction<Set<string>>>;
  onPublish: () => void;
  dubbing: { done: number; total: number } | null;
  dubMsg: string | null;
}) {
  const [detail, setDetail] = useState<Listing | null>(null);
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

      {dubbing && (
        <div className="mb-3 flex items-center gap-2 rounded-xl border border-wb-pink/30 bg-wb-pink/[0.06] px-4 py-2.5 text-xs text-wb-pink">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          视频配俄语中 {dubbing.done}/{dubbing.total} …(每条约 1–2 分钟,完成后卡片右上出现「俄」角标)
        </div>
      )}
      {dubMsg && (
        <div className="mb-3 rounded-xl border border-amber-400/30 bg-amber-500/[0.08] px-4 py-2.5 text-xs text-amber-700 dark:text-amber-200">
          {dubMsg}
        </div>
      )}

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
                    <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-1.5 py-0.5 text-[10px] text-emerald-600 dark:text-emerald-300">
                      <CheckCircle2 className="h-3 w-3" /> 就绪
                    </span>
                  ) : (
                    <span className="rounded-full bg-rose-500/10 px-1.5 py-0.5 text-[10px] text-rose-600 dark:text-rose-300">
                      待修 / 失败
                    </span>
                  )}
                </div>
                <div className="mt-2 flex items-center justify-between border-t border-slate-900/[0.06] pt-2 dark:border-white/[0.06]">
                  <button
                    onClick={() => setDetail(l)}
                    className="text-[10.5px] text-slate-500 hover:text-slate-800 dark:hover:text-slate-200"
                  >
                    查看详情
                  </button>
                  {ok ? (
                    <label className="flex cursor-pointer items-center gap-1 text-[10.5px] text-slate-600 dark:text-slate-300">
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

      {detail && <ReviewDetailModal listing={detail} onClose={() => setDetail(null)} />}
    </div>
  );
}

// 审核「查看详情」弹窗 —— 只读看全图 + 俄/中文案,不离开批量流程。
function ReviewDetailModal({ listing, onClose }: { listing: Listing; onClose: () => void }) {
  const c = listing.copy;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        className="card flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden p-0"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex shrink-0 items-center justify-between border-b border-slate-900/[0.06] px-5 py-3.5 dark:border-white/[0.06]">
          <div className="min-w-0 truncate text-sm font-medium text-slate-900 dark:text-slate-100">
            {c?.title || listing.productName}
          </div>
          <button
            onClick={onClose}
            className="grid h-7 w-7 place-items-center rounded-lg text-slate-500 hover:bg-slate-900/[0.05] dark:hover:bg-white/5"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {listing.images.length > 0 && (
            <div className="mb-4 grid grid-cols-3 gap-2 sm:grid-cols-4">
              {listing.images.map((img) => (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  key={img.id}
                  src={img.url}
                  alt={img.kind}
                  className="aspect-[3/4] w-full rounded-lg border border-slate-900/10 object-cover dark:border-white/10"
                />
              ))}
            </div>
          )}
          <div className="space-y-3 text-sm">
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500 dark:text-slate-400">
              <span>
                售价 <b className="text-wb-pink">{listing.price.toLocaleString()} ₽</b>
                {listing.discount ? ` · -${listing.discount}%` : ""}
              </span>
              {c?.categoryHint && <span>类目: {c.categoryHint}</span>}
              {listing.videoRu && <span className="text-emerald-600 dark:text-emerald-400">✓ 含俄语视频</span>}
            </div>
            {c && (
              <>
                <div>
                  <div className="label">标题</div>
                  <p className="rounded-lg bg-slate-900/[0.04] px-3 py-2 text-slate-900 dark:bg-white/5 dark:text-slate-100">
                    {c.title}
                  </p>
                  {c.titleZh && <p className="mt-1 px-3 text-xs text-slate-500 dark:text-slate-400">{c.titleZh}</p>}
                </div>
                <div>
                  <div className="label">描述</div>
                  <p className="max-h-40 overflow-auto whitespace-pre-wrap rounded-lg bg-slate-900/[0.04] px-3 py-2 leading-relaxed text-slate-700 dark:bg-white/5 dark:text-slate-300">
                    {c.description}
                  </p>
                  {c.descriptionZh && (
                    <p className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap px-3 text-xs text-slate-500 dark:text-slate-400">
                      {c.descriptionZh}
                    </p>
                  )}
                </div>
                {c.bullets.length > 0 && (
                  <div>
                    <div className="label">卖点</div>
                    <ul className="space-y-1">
                      {c.bullets.map((b, i) => (
                        <li key={i} className="flex items-start gap-2 text-slate-700 dark:text-slate-300">
                          <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
                          <span>
                            {b}
                            {c.bulletsZh?.[i] && (
                              <span className="block text-xs text-slate-500 dark:text-slate-400">
                                {c.bulletsZh[i]}
                              </span>
                            )}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </>
            )}
            {listing.error && (
              <p className="rounded-lg bg-rose-500/10 px-3 py-2 text-xs text-rose-600 dark:text-rose-300">
                {listing.error}
              </p>
            )}
          </div>
        </div>
        <div className="shrink-0 border-t border-slate-900/[0.06] px-5 py-3 text-right dark:border-white/[0.06]">
          <button className="btn-ghost px-4 py-1.5 text-xs" onClick={onClose}>
            关闭
          </button>
        </div>
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
          建卡 + 传图/视频会先逐张完成。<b>新卡通常要等 WB 审核(常 24h 内)通过后才能定价</b> —— 届时到「商品管理」给它们补价;WB 也会限制改价频率,逐张排队即可。
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
